-- Up Migration
--
-- Трекинг листингов/делистингов для LLM-контекста (владелец: «что листят, что
-- делистят»). Коллектор на каждом обновлении вселенной отмечает last_seen для
-- текущих символов; отсюда выводятся:
--   listed   — символы с недавним first_seen (появились), КРОМЕ базового
--              наполнения при холодном старте (is_baseline), иначе вся вселенная
--              выглядела бы «только что залистованной» первые пару дней.
--   delisted — символы, чей last_seen устарел (пропали из вселенной), но не
--              слишком давно (чтобы не тянуть вечно давно ушедшие).
--
-- Отдельная маленькая таблица, а не диф в памяти: рендер LLM-контекста живёт в
-- killswitch-listener (другой процесс), а пишет коллектор — им нужен общий
-- носитель, и БД здесь единственный.

CREATE TABLE IF NOT EXISTS tracked_symbols (
  symbol text PRIMARY KEY,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  -- true только для символов, вставленных при ПЕРВОМ наполнении пустой таблицы:
  -- они не «новые листинги», а базовая линия, от которой считаем изменения.
  is_baseline boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS tracked_symbols_last_seen_idx ON tracked_symbols (last_seen);
CREATE INDEX IF NOT EXISTS tracked_symbols_first_seen_idx ON tracked_symbols (first_seen);

-- Down Migration

DROP TABLE IF EXISTS tracked_symbols;
