# Visual Inspiration

Reference images and the specific thing we want to steal from each. Images live
in `inspo/`.

## Tower HP and Cooldown Bars

![Bars visible](inspo/tower-bars-visible.png)
![Bars hidden](inspo/tower-bars-hidden.png)

**Tags:** `Game Feel / Juice`, `Immersion`

Floating bars attached to a tower, drawn under it rather than over the world.

- Bar sits at the base/bottom of the tower, not floating high above it.
- Rounded pill shape, dark outline, thick enough to read at a glance.
- HP bar: green when healthy, shifts to orange/red as it drops.
- Cooldown bar: fills as the build/upgrade/reload progresses.
- Both bars can stack; only the relevant ones are shown.

**Key behavior:** bars auto-hide.

- HP bar is hidden at full HP, appears on damage.
- Cooldown bar is hidden when the cooldown is done, appears while charging.
- A healthy, idle tower is completely clean — no UI chrome at all (second image).

**Why:** the world stays uncluttered by default, and any visible bar instantly
means "something needs attention here."

**Open questions:**

- Do bars fade out after a delay at full HP, or snap off immediately?
- Same treatment for the main base, buildings under construction, and enemies?
- Do bars scale/billboard with camera zoom?
