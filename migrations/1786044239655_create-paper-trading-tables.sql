-- Up Migration
--
-- Фаза 2 (эмуляция/paper trading), задача #37 бэклога. Виртуальные сценарии
-- paper-трейдинга — бот прогоняет несколько одновременных "что если" сценариев
-- (разное плечо/параметры) поверх РЕАЛЬНЫХ рыночных данных (funding_rates,
-- tickers, ... из create-market-data-tables.sql), не отправляя ни одного
-- реального ордера на биржу.
--
-- Почему это ОТДЕЛЬНЫЕ paper_*-таблицы, а не флаг is_virtual на существующих
-- positions/orders/fills (create-position-tables.sql): та миграция сама
-- фиксирует `order_link_id text NOT NULL UNIQUE` на orders (RR-11:
-- идемпотентный ключ ретраев к реальной бирже) и `exec_id text NOT NULL
-- UNIQUE` на fills (RSK-46: дедупликация по execId биржи при WS/REST
-- переподключении) — оба NOT NULL UNIQUE специально под биржевую
-- идемпотентность, у которой нет смысла для симулированного события:
-- paper-заливка не отправляется на биржу и не имеет execId биржи. Общая
-- таблица с флагом заставила бы либо (a) сделать эти колонки nullable —
-- тихо ослабляя гарантию идемпотентности и для РЕАЛЬНЫХ строк тоже (Postgres
-- не умеет "NOT NULL только если is_virtual = false" без отдельного
-- CHECK-хака), либо (b) генерировать фиктивные order_link_id/exec_id под
-- каждое виртуальное событие — тогда это уже не тот же механизм
-- идемпотентности, а его подделка. Хуже: общая таблица — это постоянный риск,
-- что запрос забудет `WHERE is_virtual = false` и незаметно подмешает
-- симулированный P&L в решение о реальном капитале — денежный баг совсем
-- другого класса, чем чуть более многословная схема. Полностью отдельные
-- paper_*-таблицы делают эту ошибку структурно невозможной: запрос к
-- `positions` физически не может увидеть строку `paper_positions`.
--
-- Правила ADR-003/NFR-01..03, те же, что в create-position-tables.sql:
-- деньги/qty/price/rate/fee/leverage — bare `numeric` без precision/scale.
-- Времена здесь — ВСЕГДА timestamptz, не bigint-мс: в отличие от market-data/
-- position-таблиц, paper-данные не воспроизводят ни одной реальной метки
-- времени биржи — они управляются собственными часами бота/симуляции.
--
-- Все FK — `ON DELETE RESTRICT`, тот же принцип, что и в
-- create-position-tables.sql: потеря истории paper-сценария через каскадное
-- удаление недопустима для последующего анализа результатов.
--
-- paper_scenarios.status / paper_positions.state — намеренно голый `text` без
-- CHECK/enum, той же причиной, что positions.state в create-position-tables.sql:
-- модель состояний ещё не зафиксирована (открытая задача бэклога — "решить
-- pairIntentState.ts reuse vs новая paperPositionState.ts").

-- Один сценарий = один independent "что если" прогон с фиксированным набором
-- параметров (сейчас — только leverage, но status/started_at/stopped_at
-- допускают несколько сценариев параллельно и историю уже остановленных).
CREATE TABLE paper_scenarios (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  leverage numeric NOT NULL,
  starting_deposit numeric NOT NULL DEFAULT 500,
  status text NOT NULL,
  started_at timestamptz,
  stopped_at timestamptz
);

-- Одна строка = одна дельта-нейтральная пара внутри сценария целиком, не две
-- независимые ноги — та же причина, что у реальной `positions`
-- (ARCHITECTURE.md §4: раздельные состояния ног рассинхронизируются).
-- spot_qty/perp_qty nullable по той же причине, что у `positions`: строка
-- существует уже на стадии намерения, когда объём ещё не известен.
CREATE TABLE paper_positions (
  id bigserial PRIMARY KEY,
  scenario_id bigint NOT NULL REFERENCES paper_scenarios (id) ON DELETE RESTRICT,
  symbol text NOT NULL,
  state text NOT NULL,
  spot_qty numeric,
  perp_qty numeric,
  leverage numeric NOT NULL, -- решается при открытии позиции, в отличие от qty — не зависит от факта исполнения
  entry_reasoning text, -- FR-202: обоснование решения на входе, а не факт
  opened_at timestamptz,
  closed_at timestamptz,
  -- Известны только при закрытии позиции (scenarioRunner.ts closePosition),
  -- поэтому nullable по той же причине, что и spot_qty/perp_qty выше — до
  -- закрытия значение ещё не вычислено, а не "ноль по факту". Хранятся как
  -- положительная величина издержки (та же знак-конвенция, что у paper_fills.fee),
  -- не уже вычтенное значение — знак применяется читателем (см. reportGenerator.ts).
  slippage_cost numeric, -- entrySpotSlippageBp/entryPerpSlippageBp, свёрнутые в доллары на обеих ногах (entry+exit)
  borrow_cost numeric -- накопленный OpenPositionState.borrowCostAccrued за всё время удержания позиции
);
CREATE INDEX ON paper_positions (scenario_id);

-- Симулированные исполнения. Без exec_id/fee_asset реальных `fills`: нет
-- биржевого execId для дедупликации (эти "исполнения" никогда не приходят по
-- WS/REST от Bybit — их генерирует симулятор), и валюта комиссии здесь не
-- моделируется отдельно (комиссия виртуальна, всегда в той же расчётной
-- единице, что и остальной paper-учёт).
CREATE TABLE paper_fills (
  id bigserial PRIMARY KEY,
  position_id bigint NOT NULL REFERENCES paper_positions (id) ON DELETE RESTRICT,
  leg text NOT NULL CHECK (leg IN ('spot', 'perp')),
  side text NOT NULL,
  qty numeric NOT NULL,
  price numeric NOT NULL,
  fee numeric NOT NULL,
  executed_at timestamptz NOT NULL
);
CREATE INDEX ON paper_fills (position_id);

-- Симулированные funding-выплаты. interval_minutes (не interval_start_ms/
-- interval_end_ms, как в реальной funding_payments) — здесь нет биржевой
-- метки интервала расчёта, есть только длительность интервала, применённая
-- к rate. Тот же CHECK > 0, что у funding_rates.interval_minutes
-- (RSK-25/FM-04): нулевой/отрицательный интервал — испорченное значение, а
-- не редкий, но валидный случай.
CREATE TABLE paper_funding_payments (
  id bigserial PRIMARY KEY,
  position_id bigint NOT NULL REFERENCES paper_positions (id) ON DELETE RESTRICT,
  amount numeric NOT NULL,
  rate numeric NOT NULL,
  interval_minutes integer NOT NULL CHECK (interval_minutes > 0),
  paid_at timestamptz NOT NULL
);
CREATE INDEX ON paper_funding_payments (position_id);

-- Hypertable — в ОТЛИЧИЕ от реальной equity_snapshots (create-position-tables.sql,
-- которая сознательно НЕ вызывает create_hypertable: "редко обновляемое
-- состояние... hypertable-партиционирование здесь избыточно"). У paper-
-- сценариев обратная посылка: mark-to-market может сэмплироваться намного
-- чаще, чем реальная equity-кривая бота, одновременно по нескольким
-- сценариям, на потенциально длинных бэктестируемых диапазонах — это ровно
-- тот высокочастотный временной ряд, под который заточены hypertable'ы
-- create-market-data-tables.sql (tickers, funding_rates, ...), а не редкая
-- смена состояния реальной equity_snapshots. Паттерн create_hypertable
-- скопирован оттуда, а не из реальной equity_snapshots.
--
-- Составной PRIMARY KEY (id, at), не голый `id`: TimescaleDB требует, чтобы
-- любой UNIQUE/PRIMARY KEY constraint на hypertable включал колонку
-- партиционирования (`at`). `id` сам по себе уже глобально уникален
-- (bigserial); `at` добавлен в ключ только чтобы удовлетворить это
-- требование Timescale, а не потому что он содержательно часть идентичности
-- строки.
CREATE TABLE paper_equity_snapshots (
  id bigserial NOT NULL,
  scenario_id bigint NOT NULL REFERENCES paper_scenarios (id) ON DELETE RESTRICT,
  at timestamptz NOT NULL DEFAULT now(),
  total_equity numeric NOT NULL,
  margin_balance numeric NOT NULL,
  is_peak boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id, at)
);
SELECT create_hypertable('paper_equity_snapshots', by_range('at'), if_not_exists => true);
CREATE INDEX ON paper_equity_snapshots (scenario_id, at);

-- Down Migration

DROP TABLE IF EXISTS paper_equity_snapshots;
DROP TABLE IF EXISTS paper_funding_payments;
DROP TABLE IF EXISTS paper_fills;
DROP TABLE IF EXISTS paper_positions;
DROP TABLE IF EXISTS paper_scenarios;
