-- Up Migration
--
-- Обнаружено во время автономной работы 2026-08-07: orderbook_levels уже
-- 7.68GB после ~1.5 суток сбора (48.5M строк, category=linear+spot,
-- market-data/collectOrderbookSnapshots.ts пишет ~35M строк/сутки), при
-- chunk_time_interval=7 дней (TimescaleDB-дефолт, ни одна из 6 гипертаблиц
-- его не переопределяла) и compression НИГДЕ не включена. VPS-диск — 78.2GB,
-- 57.5GB свободно на момент проверки. Экстраполяция без вмешательства:
-- текущий чанк (2026-08-06..2026-08-13) продолжит расти НЕСЖАТЫМ до самого
-- закрытия 2026-08-13 — по грубой оценке ещё ~30GB только для
-- orderbook_levels к этому моменту, вплотную к пределу диска с учётом
-- остальных таблиц/Docker-образов/WAL.
--
-- Два независимых изменения на все 6 гипертаблиц:
--
-- 1. chunk_time_interval уменьшен до 1 дня. Это НЕ трогает уже существующие
--    чанки (TimescaleDB не умеет ретроактивно перенарезать чанк) — влияет
--    только на чанки, которые будут созданы ПОСЛЕ этой миграции. С 7-дневным
--    интервалом первый чанк не закроется до 2026-08-13, то есть почти до
--    конца всего двухнедельного окна Фазы 1/2 — сжатие физически не могло
--    бы сработать вовремя. С 1-дневным интервалом чанки начинают закрываться
--    уже завтра, и compression успевает реально сэкономить место в течение
--    ВСЕГО окна, а не только во вторую неделю.
--
-- 2. Политика компрессии (add_compression_policy, compress_after) — действует
--    только на чанки СТАРШЕ порога, ничего не трогает прямо сейчас и не
--    блокирует текущие записи. compress_segmentby='symbol' — естественный
--    фильтр почти всех запросов в этой кодовой базе (emulation/scenarioRunner.ts,
--    reportGenerator.ts, notify/statusReport.ts и т.д. почти всегда фильтруют
--    по символу); compress_orderby=<колонка времени> DESC, симметрично тому,
--    как эти же таблицы почти всегда читаются (последняя строка на символ).
--
-- Сознательно НЕ трогаю уже накопленный ТЕКУЩИЙ чанк (2026-08-06..08-13,
-- активно пишется collector.ts прямо сейчас): принудительное сжатие
-- (compress_chunk) активно пишущегося чанка несёт риск деградации записи в
-- реальном времени — FR-109 («две недели без пропусков») важнее места на
-- диске. Он закроется естественно 2026-08-13 и будет подхвачен той же
-- политикой compress_after автоматически. До тех пор — см. новый мониторинг
-- места на диске (отдельный коммит, notify/healthcheck.ts).

ALTER TABLE orderbook_levels SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'symbol',
  timescaledb.compress_orderby = 'fetched_at DESC'
);
SELECT add_compression_policy('orderbook_levels', compress_after => INTERVAL '2 days');
SELECT set_chunk_time_interval('orderbook_levels', INTERVAL '1 day');

ALTER TABLE tickers SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'symbol',
  timescaledb.compress_orderby = 'fetched_at DESC'
);
SELECT add_compression_policy('tickers', compress_after => INTERVAL '2 days');
SELECT set_chunk_time_interval('tickers', INTERVAL '1 day');

ALTER TABLE open_interest SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'symbol',
  timescaledb.compress_orderby = 'fetched_at DESC'
);
SELECT add_compression_policy('open_interest', compress_after => INTERVAL '2 days');
SELECT set_chunk_time_interval('open_interest', INTERVAL '1 day');

ALTER TABLE long_short_ratio SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'symbol',
  timescaledb.compress_orderby = 'fetched_at DESC'
);
SELECT add_compression_policy('long_short_ratio', compress_after => INTERVAL '2 days');
SELECT set_chunk_time_interval('long_short_ratio', INTERVAL '1 day');

ALTER TABLE funding_rates SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'symbol',
  timescaledb.compress_orderby = 'fetched_at DESC'
);
SELECT add_compression_policy('funding_rates', compress_after => INTERVAL '2 days');
SELECT set_chunk_time_interval('funding_rates', INTERVAL '1 day');

ALTER TABLE liquidations SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'symbol',
  timescaledb.compress_orderby = 'received_at DESC'
);
SELECT add_compression_policy('liquidations', compress_after => INTERVAL '2 days');
SELECT set_chunk_time_interval('liquidations', INTERVAL '1 day');

-- Down Migration
--
-- Best-effort: TimescaleDB requires chunks to be decompressed before
-- compression can be disabled on the hypertable. If any chunk has already
-- been compressed by the time this runs, `ALTER TABLE ... SET
-- (timescaledb.compress = false)` will fail until those chunks are manually
-- decompressed first (decompress_chunk() per chunk) — not automated here,
-- since this down migration is a local-dev-rollback safety net, not an
-- expected production path.

SELECT remove_compression_policy('orderbook_levels', if_exists => true);
ALTER TABLE orderbook_levels SET (timescaledb.compress = false);
SELECT set_chunk_time_interval('orderbook_levels', INTERVAL '7 days');

SELECT remove_compression_policy('tickers', if_exists => true);
ALTER TABLE tickers SET (timescaledb.compress = false);
SELECT set_chunk_time_interval('tickers', INTERVAL '7 days');

SELECT remove_compression_policy('open_interest', if_exists => true);
ALTER TABLE open_interest SET (timescaledb.compress = false);
SELECT set_chunk_time_interval('open_interest', INTERVAL '7 days');

SELECT remove_compression_policy('long_short_ratio', if_exists => true);
ALTER TABLE long_short_ratio SET (timescaledb.compress = false);
SELECT set_chunk_time_interval('long_short_ratio', INTERVAL '7 days');

SELECT remove_compression_policy('funding_rates', if_exists => true);
ALTER TABLE funding_rates SET (timescaledb.compress = false);
SELECT set_chunk_time_interval('funding_rates', INTERVAL '7 days');

SELECT remove_compression_policy('liquidations', if_exists => true);
ALTER TABLE liquidations SET (timescaledb.compress = false);
SELECT set_chunk_time_interval('liquidations', INTERVAL '7 days');
