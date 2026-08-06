-- Up Migration
--
-- Фаза 1 (сборщик данных), SRS FR-100..FR-110. Только рыночные данные, без позиций.
--
-- Правила из ADR-003/NFR-01..03: деньги/ставки/цены — bare `numeric` без precision/scale
-- (numeric(p,s) молча округляет лишние знаки). Никаких чисел внутри jsonb (драйвер
-- разбирает jsonb как JSON.parse -> float). Биржевые метки времени — bigint мс,
-- ровно как приходят от Bybit (RISK-REGISTER.md FM-57) — `timestamp without time zone`
-- на торговых/рыночных таблицах не используется нигде в этой схеме.
-- `fetched_at` (timestamptz, наше собственное время наблюдения) — единая ось партиционирования
-- TimescaleDB для всех таблиц: каждая запись — это независимый сэмпл временного ряда,
-- а не апдейт текущего состояния.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- FR-109: пропуски сбора должны обнаруживаться и записываться, а не предполагаться.
-- Exit criterion Фазы 1 ("две недели без пропусков") измеряется по этой таблице.
CREATE TABLE collection_runs (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  symbols_expected integer,
  symbols_collected integer,
  error text
);

-- FR-100/FR-101/FR-102: funding rates, исторические (kind='settled') и текущий
-- прогнозный (kind='predicted'). interval_minutes NOT NULL — RSK-25/FM-04:
-- Bybit-интервал не всегда 8ч и меняется на лету, хранение ставки без интервала
-- запрещено требованием, а не только соглашением.
-- PK включает funding_timestamp_ms: догон нескольких пропущенных settlement'ов
-- одного символа одним свипом (collectSettledFunding.ts) пишет несколько строк
-- с ОДНИМ fetched_at, но РАЗНЫМИ funding_timestamp_ms — без этого поля в ключе
-- такая запись конфликтует сама с собой (поймано тестом до того, как это стало
-- багом в проде, а не после).
CREATE TABLE funding_rates (
  symbol text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('settled', 'predicted')),
  rate numeric NOT NULL,
  interval_minutes integer NOT NULL CHECK (interval_minutes > 0),
  funding_timestamp_ms bigint NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, kind, funding_timestamp_ms, fetched_at)
);
SELECT create_hypertable('funding_rates', by_range('fetched_at'), if_not_exists => true);
CREATE INDEX ON funding_rates (symbol, funding_timestamp_ms);

-- FR-103: спот-цены, перп-цены, базис между ними (перп.mark_price - спот.last_price,
-- считается на уровне приложения из двух строк этой таблицы, не хранится отдельно).
CREATE TABLE tickers (
  symbol text NOT NULL,
  category text NOT NULL CHECK (category IN ('linear', 'spot')),
  last_price numeric NOT NULL,
  mark_price numeric,
  index_price numeric,
  volume_24h numeric,
  turnover_24h numeric,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, category, fetched_at)
);
SELECT create_hypertable('tickers', by_range('fetched_at'), if_not_exists => true);

-- FR-105: open interest и его динамика.
CREATE TABLE open_interest (
  symbol text NOT NULL,
  open_interest numeric NOT NULL,
  data_period text NOT NULL,
  data_timestamp_ms bigint NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, fetched_at)
);
SELECT create_hypertable('open_interest', by_range('fetched_at'), if_not_exists => true);

-- FR-106: long/short account ratio.
CREATE TABLE long_short_ratio (
  symbol text NOT NULL,
  buy_ratio numeric NOT NULL,
  sell_ratio numeric NOT NULL,
  data_period text NOT NULL,
  data_timestamp_ms bigint NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, fetched_at)
);
SELECT create_hypertable('long_short_ratio', by_range('fetched_at'), if_not_exists => true);

-- FR-107: поток ликвидаций по WebSocket, топик allLiquidation.{symbol} (старый
-- топик "liquidation" депрекейтнут с 2025-02-20, см. DECISIONS.md ADR-006).
-- PK намеренно включает received_at: настоящая дедупликация редоставленных при
-- реконнекте событий — задача application-слоя (см. будущий execution/-аналог
-- дедупликации по execId, FM-22), а не этой миграции.
CREATE TABLE liquidations (
  symbol text NOT NULL,
  side text NOT NULL CHECK (side IN ('Buy', 'Sell')),
  size numeric NOT NULL,
  price numeric NOT NULL,
  liquidation_time_ms bigint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, liquidation_time_ms, side, size, price, received_at)
);
SELECT create_hypertable('liquidations', by_range('received_at'), if_not_exists => true);

-- FR-104: снимки стакана, не полный поток дельт (PARAMS-CONSERVATIVE.md §1: топ-50
-- раз в минуту по торгуемому юниверсу). Нормализовано по уровням, а не jsonb-массивом —
-- NFR-03: числа внутри jsonb драйвер вернёт как float, это прямое нарушение ADR-003.
CREATE TABLE orderbook_levels (
  symbol text NOT NULL,
  category text NOT NULL CHECK (category IN ('linear', 'spot')),
  side text NOT NULL CHECK (side IN ('bid', 'ask')),
  level_index smallint NOT NULL CHECK (level_index >= 0),
  price numeric NOT NULL,
  qty numeric NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, category, side, level_index, fetched_at)
);
SELECT create_hypertable('orderbook_levels', by_range('fetched_at'), if_not_exists => true);

-- Down Migration

DROP TABLE IF EXISTS orderbook_levels;
DROP TABLE IF EXISTS liquidations;
DROP TABLE IF EXISTS long_short_ratio;
DROP TABLE IF EXISTS open_interest;
DROP TABLE IF EXISTS tickers;
DROP TABLE IF EXISTS funding_rates;
DROP TABLE IF EXISTS collection_runs;
