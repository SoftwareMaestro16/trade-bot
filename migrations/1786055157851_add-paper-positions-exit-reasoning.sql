-- Up Migration
--
-- Owner's own words (перевод с русского): "важно сделать так, чтобы была более
-- детальная и ясная причина почему удалось заработать или потерять деньги и при
-- каких условиях... что, почему, из-за чего, что происходило на рынке." —
-- paper_positions.entry_reasoning (1786044239655_create-paper-trading-tables.sql)
-- already captures the "почему вошли" half of that; this column adds the
-- symmetric "почему и при каких условиях вышли" half, so a closed position's
-- full story lives on the same row instead of needing a join against
-- paper_fills/paper_funding_payments to reconstruct.
--
-- Nullable, same reasoning as entry_reasoning and as slippage_cost/borrow_cost
-- on the same table: the row exists from OPEN (scenarioRunner.ts
-- openNewPosition) onward, long before a close reason exists to write —
-- NULL here means "not closed yet", not "closed for no reason". Text, not a
-- CHECK/enum: same "not stabilized yet" reasoning as paper_positions.state
-- itself (see create-paper-trading-tables.sql's own docstring) — exitRules.ts's
-- own reasonCode set (BASIS_DIVERGED / DELISTED_OR_CONTRACT_CHANGED /
-- FUNDING_TURNED_NEGATIVE / APR_HYSTERESIS_TRIGGERED) plus scenarioRunner.ts's
-- own FORCED_LIQUIDATION / SCENARIO_END aren't pinned down at the schema level
-- any more than paper_positions.state's own open string set is.
ALTER TABLE paper_positions
  ADD COLUMN exit_reasoning text;

-- Down Migration

ALTER TABLE paper_positions
  DROP COLUMN exit_reasoning;
