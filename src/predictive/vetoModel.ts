import type { FundingEpisodeFeatures } from "./episodeFeatures.js";

/**
 * OPEN-QUESTIONS.md #22: "офлайн-модель на данных Фазы 1, предсказывающая
 * «доживёт ли положительный funding следующие N часов», с правом
 * исключительно вето." This interface is the plug point that decision
 * exists for — the trained model itself is out of scope here (see
 * `src/scripts/exportPredictiveTrainingDataset.ts`'s own doc comment: this
 * repo exports the labeled dataset, training happens offline in a
 * notebook, separate from this codebase). Three properties are fixed by
 * this interface's shape and must survive whatever concrete implementation
 * eventually replaces `NoOpVetoModel`:
 *
 * (a) VETO-ONLY, STRUCTURALLY. `shouldVeto` returns a single `boolean`, not a
 *     three-way "force-enter / neutral / veto" signal — there is no return
 *     value this method could produce that forces or unlocks an entry. The
 *     model can only ever subtract candidates a normal, deterministic
 *     `strategy/`+`risk/` pass already found acceptable; it can never add
 *     one. Same "veto power, never entry power" shape as `risk/`'s own
 *     `VetoResult` (`src/risk/types.ts`), deliberately reduced further to a
 *     plain boolean since a predictive model, unlike a deterministic
 *     `risk/` check, has no fixed `code`/`reason` taxonomy to report against.
 *
 * (b) NOT WIRED UP TODAY. No caller anywhere in this codebase — not
 *     `emulation/scenarioRunner.ts`, not any future live decision loop —
 *     invokes `shouldVeto` yet. This module is a skeleton for a later
 *     integration, not a live one. `NoOpVetoModel` below is the only
 *     implementation that exists today, and it has no opinion ("не
 *     вмешивайся") — it is what a caller gets if it wires this interface in
 *     before a trained model is ready, and it is deliberately safe to wire
 *     in that state (it changes nothing).
 *
 * (c) VETO AFTER, NEVER INSTEAD OF, ordinary trading logic. Whenever this
 *     interface DOES get wired into a real decision path, the calling code
 *     is obligated to run it strictly AFTER `strategy/`+`risk/` have already
 *     identified a candidate through their normal, deterministic rules — as
 *     one more filter stacked on top, the same position `risk/`'s own
 *     checks occupy relative to `strategy/rankCandidates.ts` (RSK-29: ranking
 *     is not vetoing, vetoing lives downstream of ranking). A future
 *     implementation must never be consulted to originate a candidate, only
 *     to strike one down.
 */
export interface PredictiveVetoModel {
  shouldVeto(features: FundingEpisodeFeatures): boolean;
}

/**
 * Today's only implementation — "нет мнения, не вмешивайся". Always
 * `false`, unconditionally: no trained model exists yet, so this model
 * abstains from every decision rather than guessing. See the module doc
 * comment above for why a caller wiring this in changes nothing about
 * present behavior.
 */
export class NoOpVetoModel implements PredictiveVetoModel {
  shouldVeto(features: FundingEpisodeFeatures): boolean {
    void features; // deliberately unexamined — no trained model exists yet, see class doc comment above.
    return false;
  }
}
