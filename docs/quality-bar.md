# The quality bar (2026-08-13)

Saved verbatim from the art-direction session. This is the standing order for all model work.

---

> I want you to update all relevant doc, specially the assets one, with what we have for models,
> descriptions / motions / and accessories for usage and for charm. Save this prompt into a file too.
>
> We are setting a new bar for the game. Unsure best approach for you to test each view of model,
> maybe add a model viewer if need be or dont.
>
> /goal I want you to build all workers and update the whole. It should spawn the full 3x3 grid it
> covers. at the level of the 2 reference images. or better. it should be utterly perfect with top
> quality.
>
> Fan out sub-agents and have sub-agents tackle each individually so that the models / animations
> are perfect. You should /loop on each item, have a separate sub-agent check it to ensure it is top
> quality. That separate sub-agent should be a really harsh critic, and if it isn't top tier, it
> should keep going.
>
> Don't stop until each sub-agent is utterly wowed with the quality when compared with reference.
> It should literally compare them side by side blind and say which one looks better. Fan out
> sub-agents and ultracode.
>
> Do smart things. And believe in yourself.

---

## What this means operationally

- **References are law:** `docs/reference/workers.png` and `docs/reference/enemies.png`. Every model
  is judged by blind side-by-side against them. "As good or better," nothing less.
- **Scope of the standing order:** the five peg workers (gatherer, courier, builder, guard, carrier)
  with accessories and motion, and the main base (the hole), filling its full 3×3 footprint.
- **Verification loop:** build → render screenshots from the model viewer → a harsh critic compares
  blind against reference → iterate until the critic is wowed. The critic never rubber-stamps.
- **Spec lives in** `docs/model-spec.md`; generation prompts in `docs/asset-prompts.md`.
