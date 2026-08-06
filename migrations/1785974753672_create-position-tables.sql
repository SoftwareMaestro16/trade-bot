-- Up Migration
--
-- Фаза 2+ (strategy/risk/execution), ARCHITECTURE.md §3 (схема БД, сокращённо)
-- и §4 (машина состояний позиции). Состояние позиций, журнал намерений,
-- ордера, исполнения, funding-выплаты, вето риска, снимки equity.
--
-- Правила из ADR-003/NFR-01..03, те же, что в 1785958682080_create-market-data-tables:
-- деньги/qty/price/rate/fee — bare `numeric` без precision/scale (numeric(p,s)
-- молча округляет лишние знаки). Никаких чисел внутри jsonb-колонок (payload,
-- intent) — драйвер разбирает jsonb как JSON.parse -> float (NFR-03); денежные
-- значения обязаны жить в отдельных numeric-колонках той же строки. Биржевые
-- метки времени — bigint мс в полях `*_ms`, ровно как приходят от Bybit;
-- `timestamptz` — только для собственного времени наблюдения/записи бота
-- (created_at/at/sent_at/...), никогда для биржевых меток.
--
-- Без create_hypertable: в отличие от market-data это не временные ряды
-- высокой частоты, а редко обновляемое состояние + append-only журналы —
-- hypertable-партиционирование здесь избыточно.
--
-- `positions.state` и `orders.status` — намеренно голый `text`, БЕЗ CHECK/enum:
-- список состояний машины (ARCHITECTURE.md §4) ещё не стабилизирован, фиксация
-- в CHECK-констрейнте — задача отдельной будущей миграции, когда стабилизируется.
--
-- Все FK — `ON DELETE RESTRICT`: потеря истории позиции/ордера через
-- каскадное удаление недопустима для денежного аудита.

-- Одна строка = одна дельта-нейтральная пара (спот+перп) целиком, а не две
-- независимые ноги — ARCHITECTURE.md §4: раздельные состояния ног легко
-- рассинхронизируются между «что бот думает о ноге A» и «...о ноге B».
-- spot_qty/perp_qty nullable: строка создаётся в момент перехода
-- IDLE -> ENTRY_PENDING, когда объём ещё не известен (известно только намерение).
CREATE TABLE positions (
  id bigserial PRIMARY KEY,
  symbol text NOT NULL,
  state text NOT NULL,
  spot_qty numeric,
  perp_qty numeric,
  entry_reasoning text, -- FR-202: обоснование решения на входе, а не факт
  opened_at timestamptz,
  closed_at timestamptz,
  peak_equity_at_open numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Журнал намерений — пишется ДО отправки в сеть (RR-12): восстановление после
-- сбоя опирается на этот журнал, а не на память процесса. position_id nullable:
-- при первом входе намерение существует раньше самой строки в `positions`.
CREATE TABLE position_intents (
  id bigserial PRIMARY KEY,
  position_id bigint REFERENCES positions (id) ON DELETE RESTRICT,
  intent_type text NOT NULL, -- 'open' | 'close' | 'unwind_leg'
  -- NFR-03: без денежных полей внутри jsonb — только идентификаторы и
  -- нечисловые параметры намерения. Денежное значение — intended_qty ниже.
  payload jsonb NOT NULL,
  intended_qty numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON position_intents (position_id);

-- order_link_id — идемпотентный ключ (RR-11): повторная отправка одного и
-- того же намерения детерминированно использует тот же orderLinkId, что
-- делает безопасным ретрай после LEG*_UNKNOWN без риска задвоить ордер.
CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  position_id bigint REFERENCES positions (id) ON DELETE RESTRICT,
  leg text NOT NULL CHECK (leg IN ('spot', 'perp')),
  side text NOT NULL,
  order_link_id text NOT NULL UNIQUE,
  intended_qty numeric NOT NULL,
  -- 'intent'|'sent'|'acked'|'filled'|'partial'|'failed'|'unknown' (ARCHITECTURE.md
  -- §4); не CHECK — аналогично positions.state, состояния ещё не стабилизированы.
  status text NOT NULL,
  exchange_order_id text,
  sent_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON orders (position_id);

-- Append-only (FR-308): исполнения никогда не апдейтятся и не удаляются
-- штатно. exec_id UNIQUE — дедупликация по execId биржи (RSK-46): WS/REST
-- переподключение может доставить одно и то же исполнение более одного раза.
CREATE TABLE fills (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  qty numeric NOT NULL,
  price numeric NOT NULL,
  fee numeric NOT NULL,
  fee_asset text NOT NULL,
  executed_at timestamptz NOT NULL,
  exec_id text NOT NULL UNIQUE
);
CREATE INDEX ON fills (order_id);

-- Append-only (FR-308): каждая funding-выплата — независимый факт, а не
-- апдейт текущего состояния. interval_start_ms/interval_end_ms — биржевые
-- метки, поэтому bigint мс, как funding_timestamp_ms в market-data-таблицах.
CREATE TABLE funding_payments (
  id bigserial PRIMARY KEY,
  position_id bigint NOT NULL REFERENCES positions (id) ON DELETE RESTRICT,
  symbol text NOT NULL,
  amount numeric NOT NULL,
  rate numeric NOT NULL,
  interval_start_ms bigint NOT NULL,
  interval_end_ms bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON funding_payments (position_id);

-- Append-only, FR-307: "все срабатывания вето risk/ с причинами" — каждый
-- прогон risk/ пишется сюда, не только отказы. veto_code NULL значит "прошло
-- без вето"; NOT NULL — конкретный код вроде 'LEVERAGE_EXCEEDED'. Форма
-- зеркалит VetoResult (src/risk/types.ts): {allowed:true} -> veto_code/
-- veto_reason NULL; {allowed:false, code, reason} -> оба заполнены.
-- intent jsonb — символ и контекст решения, без денежных значений внутри
-- (NFR-03); факты, вызвавшие (не)вето — в threshold_value/actual_value.
CREATE TABLE risk_vetoes (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  intent jsonb NOT NULL,
  veto_code text,
  veto_reason text,
  threshold_value numeric,
  actual_value numeric
);

-- Снимки total equity / margin balance. peak_equity_at_open (на positions)
-- фиксирует значение отсюда на момент открытия позиции; is_peak отмечает
-- снимки, ставшие новым пиком equity на момент записи (просадка RR-15/RR-20
-- считается от них).
CREATE TABLE equity_snapshots (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  total_equity numeric NOT NULL,
  margin_balance numeric NOT NULL,
  is_peak boolean NOT NULL DEFAULT false
);

-- Down Migration

DROP TABLE IF EXISTS equity_snapshots;
DROP TABLE IF EXISTS risk_vetoes;
DROP TABLE IF EXISTS funding_payments;
DROP TABLE IF EXISTS fills;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS position_intents;
DROP TABLE IF EXISTS positions;
