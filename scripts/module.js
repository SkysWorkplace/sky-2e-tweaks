const MODULE_ID = "sky-2e-tweaks";

// Registry of all tweaks — each tweak adds itself here.
// { id, name, hint, default, onEnable, onDisable }
const TWEAKS = [];

/**
 * Register a tweak. Call this at module load time.
 * @param {object} tweak
 * @param {string} tweak.id - Unique setting key
 * @param {string} tweak.name - Display name
 * @param {string} tweak.hint - Description shown in settings
 * @param {boolean} [tweak.default=true] - Default enabled state
 * @param {Function} [tweak.onEnable] - Called when tweak is active at ready time
 * @param {Function} [tweak.onDisable] - Called when tweak is toggled off (if cleanup needed)
 */
export function registerTweak(tweak) {
	TWEAKS.push(tweak);
}

// =============================================================================
// Tweak: Essence Casting — variable-cost spells
//
// Magic+ (pf2e-team-plus-magic) wraps spellcasting `cast` to drive the Essence
// Pool: a 2+ action essence spell draws Essence (+1), while a 1-action/reaction/
// free spell "leaks" it to 0. Variable-cost spells ("1 to 3") break this — the
// system never tells the wrapper how many actions were actually spent, so Magic+
// gives up and posts a "manually adjust your essence pool" warning instead.
//
// We can't auto-detect the action count, but we can ask. Rather than re-wrap
// `cast` (libWrapper would place us innermost, so Magic+'s pool write would
// clobber ours), we listen for the spell card Magic+ already posts. For an
// essence entry's variable-cost spell we prompt for the action count and apply
// the correct pool delta — fully decoupled from Magic+'s wrapper ordering.
// =============================================================================

const MAGICPLUS_ID = "pf2e-team-plus-magic";
// The exact warning Magic+ emits for variable-cost essence spells. We suppress
// it because this tweak now handles the case; if Magic+ changes the wording the
// worst case is the old toast reappears — the pool math still works.
const MAGICPLUS_VARCOST_WARNING = "variable action cost";

let _castMessageHookId = null;
let _renderMessageHookId = null;
let _origNotifyWarn = null;
let _varcostWarnWrapper = null;
// True only during the brief window we're handling a variable-cost essence cast, so the
// warn override is a no-op (pass-through) at every other time.
let _suppressVarcostWarn = false;

// Mute Magic+'s variable-cost warning for just the current macrotask. Magic+ fires that
// warning synchronously right around the cast, in the same macrotask as our handler's
// synchronous prefix, so clearing on the next tick bounds suppression to that one toast.
function _muteVarcostWarnBriefly() {
	_suppressVarcostWarn = true;
	setTimeout(() => { _suppressVarcostWarn = false; }, 0);
}

registerTweak({
	id: "essenceVariableCost",
	name: "Essence Casting: Variable-Cost Spells",
	hint: "Fixes Magic+ Essence Casting for variable-cost spells (e.g. \"1 to 3 actions\"). Prompts for how many actions you spent and adjusts the Essence Pool accordingly, instead of asking you to do it by hand.",
	default: true,
	onEnable() {
		if (!_castMessageHookId) {
			_castMessageHookId = Hooks.on("createChatMessage", _onSpellCardCreated);
		}
		// Re-inject our card sections on every render — PF2e overwrites the stored
		// message content when a spell variant is chosen, which would otherwise wipe
		// them. The sections live in a message flag, so the render hook re-applies them.
		if (!_renderMessageHookId) {
			_renderMessageHookId = Hooks.on("renderChatMessageHTML", _onRenderSpellCard);
		}
		// Swallow Magic+'s now-redundant manual-adjust warning — but only while we're
		// actively handling a variable-cost cast (gated on _suppressVarcostWarn), so an
		// unrelated warning that happens to contain the phrase still gets through.
		if (!_origNotifyWarn && ui.notifications) {
			_origNotifyWarn = ui.notifications.warn.bind(ui.notifications);
			_varcostWarnWrapper = (message, ...rest) => {
				if (_suppressVarcostWarn && typeof message === "string" && message.includes(MAGICPLUS_VARCOST_WARNING)) return;
				return _origNotifyWarn(message, ...rest);
			};
			ui.notifications.warn = _varcostWarnWrapper;
		}
	},
	onDisable() {
		if (_castMessageHookId) {
			Hooks.off("createChatMessage", _castMessageHookId);
			_castMessageHookId = null;
		}
		if (_renderMessageHookId) {
			Hooks.off("renderChatMessageHTML", _renderMessageHookId);
			_renderMessageHookId = null;
		}
		// Restore only if we're still the active wrapper — if another module wrapped warn
		// on top of ours, leave its wrapper in place rather than clobbering it.
		if (_origNotifyWarn && ui.notifications) {
			if (ui.notifications.warn === _varcostWarnWrapper) {
				ui.notifications.warn = _origNotifyWarn;
			}
			_origNotifyWarn = null;
			_varcostWarnWrapper = null;
		}
	}
});

// Parse a PF2e variable action cost ("1 to 3", "1 or 2", "2 to 3", "1-2") into
// { min, max }. Returns null for fixed costs or anything unrecognised.
function parseVariableCost(timeValue) {
	const match = String(timeValue ?? "").match(/^([1-3])\s*(?:to|or|-|–|—)\s*([1-3])$/i);
	if (!match) return null;
	const a = Number(match[1]);
	const b = Number(match[2]);
	if (a === b) return null;
	return { min: Math.min(a, b), max: Math.max(a, b) };
}

async function _onSpellCardCreated(message) {
	// Only the casting client prompts and updates the pool — avoids the GM (who
	// also receives the message) double-applying the change.
	if (message.author?.id !== game.userId) return;

	const castingId = message.flags?.pf2e?.casting?.id;
	if (!castingId) return;

	const spell = message.item;
	if (!spell || spell.type !== "spell") return;

	const range = parseVariableCost(spell.system.time?.value);
	if (!range) return;

	const actor = message.actor;
	if (!actor?.spellcasting) return;

	const entry = actor.spellcasting.get(castingId);
	if (!entry) return;

	// Only act on Essence entries (the entry carries an `essence` RollOption rule,
	// which is exactly how Magic+'s toggle marks an entry as essence-casting).
	const rules = entry.system?.rules ?? [];
	if (!rules.some(r => r.value === "essence")) return;

	// This is a variable-cost essence cast — exactly the case Magic+ can't resolve, so
	// it fires its "manually adjust ... variable action cost" toast. Briefly mute just
	// that warning (auto-clears next macrotask) rather than overriding warn permanently.
	// Done before the combat gate so it covers out-of-combat casts too.
	_muteVarcostWarnBriefly();

	// Essence draws only happen in combat — out of combat, casts go through
	// Incantations (which don't draw the pool), so don't prompt there.
	if (!_actorInCombat(actor)) return;

	const pool = actor.getResource("essence-pool");
	if (!pool) return;

	const rollOptions = actor.getRollOptions();
	if (rollOptions.includes("essence-blocked")) return;

	const isCantrip = spell.system.traits?.value?.includes("cantrip");

	// Bounded casters run a multi-stage Draw cycle. Magic+ handles their fixed-cost
	// casts, but mishandles variable ones: a variable cantrip never draws (its bounded
	// cantrip branch only fires for a fixed "2"/"3"), and a variable non-cantrip spell
	// is always treated as a *clean* advance because its leak test is the exact string
	// "1" — so a spell actually cast at 1 action wrongly grants the Second Draw +1 (and
	// can trigger Terminus). Handle both here.
	if (rollOptions.includes(BOUNDED_CASTER_OPTION)) {
		if (isCantrip) {
			await _handleBoundedVariableCantrip(message, spell, actor, pool, range);
		} else {
			await _handleBoundedVariableSpell(message, spell, actor, pool, rollOptions, range);
		}
		return;
	}

	const cycleTerminus = rollOptions.includes("feature:cycle-terminus");

	// A cantrip draws rather than spends: 2+ actions sets the pool to your essence
	// draw, 1 action does nothing. Magic+ only handles fixed 2/3-action cantrips
	// (its `"2"!==time && "3"!==time` gate), so a variable-cost cantrip never updates
	// the pool — handle it here, mirroring Magic+'s full-caster cantrip path.
	if (isCantrip) {
		await _handleVariableCantrip(message, spell, actor, pool, cycleTerminus, range);
		return;
	}

	const leak = await _promptLeakOrDraw(spell, range);
	if (leak == null) return; // Cancelled — leave the pool as-is.

	const wasAtMax = pool.value === pool.max;

	// Mirror Magic+'s full-caster logic:
	//   1 action / reaction / free  -> leak the pool to 0
	//   2+ actions                  -> draw (+1), wrapping to 0 at max
	const newValue = leak ? 0 : (wasAtMax ? 0 : pool.value + 1);

	// Reset the bounded-time toggle when a non-terminus caster tops out, matching
	// Magic+'s post-cast cleanup.
	if (!cycleTerminus && wasAtMax) {
		await actor.toggleRollOption("all", "bounded-time", null, true, "0");
	}

	await actor.updateResource("essence-pool", newValue, { render: true });

	// Magic+ adds its informational card sections via ItemAlteration description
	// rules gated on `item:cast:actions` — a number variable spells never resolve,
	// so those sections silently drop. Re-create the same addendum blocks here so a
	// variable-cost cast looks identical to a fixed-cost one.
	//   - draw  -> "increases your essence pool by 1!"  (Essence Spellcasting feat)
	//   - leak  -> "causes an essence leak..."          (Essence Spellcasting feat)
	//   - draw from a full pool with cycle-terminus also shows the Terminus section,
	//     exactly as Magic+'s `value == max` rule does for fixed-cost draws.
	// We stash the rendered HTML in a flag rather than splicing it into the stored
	// content: PF2e rewrites the content when a spell variant is picked, which would
	// wipe a content edit. The flag survives, and the render hook re-applies it.
	await _storeEssenceAddenda(message, actor, { leak, wasAtMax, cycleTerminus });
}

// Mirror Magic+'s full-caster cantrip draw for a variable-cost cantrip: 2+ actions set
// the pool to your essence draw (or +1 if already at/above it); 1 action has no essence
// effect. Drawing past max with cycle-terminus prompts a confirm, exactly as Magic+ does
// for fixed-cost cantrips. Magic+ math: `i = draw > pool ? draw : pool + 1`.
async function _handleVariableCantrip(message, spell, actor, pool, cycleTerminus, range) {
	const drew = await _promptCantripActions(spell, range);
	if (drew == null) return; // Cancelled — leave the pool as-is.
	if (!drew) return; // 1 action — a cantrip doesn't draw or leak.

	const draw = Number(actor.flags?.pf2e?.["essence-draw"]) || 0;
	const newValue = draw > pool.value ? draw : pool.value + 1;

	// Reaching past max with cycle-terminus is the Terminus moment; Magic+ confirms it
	// (declining casts the cantrip without consuming, so the pool is left untouched).
	if (newValue > pool.max && cycleTerminus) {
		const confirmed = await _confirmTerminusCantrip();
		if (!confirmed) return;
	}

	// Match Magic+'s post-cast cleanup: a non-terminus caster topping out resets the
	// bounded-time toggle.
	if (!cycleTerminus && pool.value === pool.max) {
		await actor.toggleRollOption("all", "bounded-time", null, true, "0");
	}

	await actor.updateResource("essence-pool", newValue, { render: true });
	await _storeCantripDrawAddendum(message, actor, draw);
}

// Bounded variable-cost cantrip draw. Magic+'s bounded cantrip branch only fires for a
// fixed 2/3-action cantrip (`castWrapper.ts:31`), so a variable Draw Cantrip never fills
// the pool. Mirror that branch's math: 2+ actions set the pool to your essence draw, or
// leave it if the pool is already higher (bounded uses NO +1, unlike the full-caster
// branch). 1 action does nothing. Bounded cantrips don't advance the stage or trigger
// Terminus, so neither do we. If the caster has leaked this encounter, the shared
// updateResource wrapper still applies its −1 to this draw (the Second Draw correction).
async function _handleBoundedVariableCantrip(message, spell, actor, pool, range) {
	const drew = await _promptCantripActions(spell, range);
	if (drew == null) return; // Cancelled — leave the pool as-is.
	if (!drew) return; // 1 action — a cantrip doesn't draw or leak.

	const draw = Number(actor.flags?.pf2e?.["essence-draw"]) || 0;
	const newValue = draw > pool.value ? draw : pool.value;

	if (newValue !== pool.value) {
		await actor.updateResource("essence-pool", newValue, { render: true });
	}
	await _storeCantripDrawAddendum(message, actor, draw);
}

// Bounded variable-cost non-cantrip essence spell. Magic+ already advances the cycle and
// resets essence to 0 for these, but it hardcodes `leaked = false` for any variable cost
// (its leak test is the exact string "1"), so a spell actually cast at 1 action is wrongly
// counted as a *clean* advance — granting the Second Draw +1 on your next draw and, at 2nd
// Draw with a full pool, triggering Terminus. We prompt for the real action count and, on a
// 1-action cast, mark the leak (so the Second Draw correction fires) and undo any Terminus
// Magic+ wrongly granted. 2+ actions is a clean advance, which is what Magic+ already did.
async function _handleBoundedVariableSpell(message, spell, actor, pool, rollOptions, range) {
	const preStage2 = rollOptions.includes(`${BOUNDED_TIME_OPTION}:2`);
	const leak = await _promptLeakOrDraw(spell, range);
	if (leak == null) return; // Cancelled — leave Magic+'s default (clean advance).

	if (!leak) {
		// 2+ actions: a clean advance — exactly what Magic+ already performed. The card
		// section is stage-aware (and carries the Terminus line at 2nd Draw), built from
		// the PRE-cast rollOptions captured before Magic+ toggled the stage.
		await _storeBoundedSpellAddendum(message, actor, false, rollOptions);
		return;
	}

	// 1 action = an essence leak. Record it so the next Second Draw is corrected by the
	// shared updateResource wrapper (only meaningful while the leak tweak is active).
	if (_leakActive) _essenceLeaked.add(actor.id);

	// Undo a Terminus Magic+ wrongly granted: at 2nd Draw with a full pool it advances to
	// 3rd Draw (`bounded-time:3`) on a "clean" cast, but a leak should end the cycle. If we
	// entered this cast at 2nd Draw and Magic+ has since moved us to 3rd Draw, reset to Out
	// of Essence (stage 0) with an empty pool. (Runs after the prompt resolves, i.e. after
	// Magic+'s synchronous post-cast writes, so this correction lands last.)
	if (preStage2 && actor.getRollOptions().includes(`${BOUNDED_TIME_OPTION}:3`)) {
		await actor.toggleRollOption("all", BOUNDED_TIME_OPTION, null, true, "0");
		await actor.updateResource("essence-pool", 0, { render: true });
	}

	await _storeBoundedSpellAddendum(message, actor, true, rollOptions);
}

// The Magic+ "Advance Essence" macro link the native addendum sections carry.
const ADVANCE_ESSENCE_UUID = "Compendium.pf2e-team-plus-magic.macros.Macro.xeIg0bIuK8AgH5AR";
const ESSENCE_ADDENDA_FLAG = "essenceAddenda";

// Build the Magic+ essence card sections, enrich their @UUID links, and stash them
// on the message so the render hook can (re-)inject it. Each entry carries a `match`
// phrase the render hook uses to detect a native equivalent and avoid duplicating it
// (PF2e resolves `item:cast:actions` once a variant is chosen, so the native section
// can appear on re-render).
async function _storeEssenceAddenda(message, actor, { leak, wasAtMax, cycleTerminus }) {
	const TextEditor = foundry.applications.ux.TextEditor.implementation;
	const enrich = (html) => TextEditor.enrichHTML(html, { relativeTo: actor });
	const entries = [];

	const essenceLabel = _findEssenceFeatName(actor);
	const advanceLink = `@UUID[${ADVANCE_ESSENCE_UUID}]{Advance Essence}`;
	entries.push({
		match: leak ? "causes an essence leak" : "increases your essence pool by 1",
		html: await enrich(_addendum(essenceLabel, [
			leak
				? "Casting this spell causes an essence leak, reducing you to 0 essence!"
				: "Casting this spell increases your essence pool by 1!",
			advanceLink
		]))
	});

	// A full pool drawn at max is the Terminus moment for cycle-terminus casters.
	// Magic+'s native Terminus rule won't fire here (it requires essence == max, but
	// the draw already reset us to 0), so this section is ours alone to provide.
	if (!leak && wasAtMax && cycleTerminus) {
		const terminus = _findTerminusFeat(actor);
		if (terminus) {
			entries.push({
				match: terminus.uuid,
				html: await enrich(_addendum(terminus.name, [
					"Casting this spell causes your essence pool to reset back to 0 and you reach your Terminus!",
					`@UUID[${terminus.uuid}]`
				]))
			});
		}
	}

	await message.setFlag(MODULE_ID, ESSENCE_ADDENDA_FLAG, entries);
}

// Re-inject the stored essence sections each time the card renders. PF2e replaces
// the card's content when a variant is chosen, so the sections must be re-applied
// on render rather than persisted in the content. Each section is skipped if an
// equivalent addendum (native Magic+ or our own) is already present, so a section
// the system renders natively isn't duplicated. Touches DOM only — no document
// writes — so it can't trigger a render loop.
function _onRenderSpellCard(message, html) {
	const cardContent = html.querySelector?.(".card-content");
	if (!cardContent) return;

	// Normalize Magic+'s native Terminus wording to our reworded copy. Runs on every
	// spell card, since native Terminus sections appear on fixed-cost essence spells
	// (which we don't inject on). DOM-only text swap — no document writes.
	_normalizeTerminusText(cardContent);

	const entries = message.flags?.[MODULE_ID]?.[ESSENCE_ADDENDA_FLAG];
	if (!entries?.length) return;

	for (const { match, html: sectionHtml } of entries) {
		const exists = [...cardContent.querySelectorAll(".addendum")].some(
			el => el.textContent.includes(match) || el.innerHTML.includes(match)
		);
		if (exists) continue;
		cardContent.insertAdjacentHTML("beforeend", sectionHtml);
	}
}

// Magic+'s native Terminus addendum text reads "…and for you to gain a choice of one
// Terminus effect!"; Terminus is a one-time level-3 choice, so we reword it in place to
// match our injected copy. Only the prose paragraph is touched (the @UUID link sits in
// a separate <p>), so textContent swapping can't clobber a link.
const TERMINUS_JANKY_PHRASE = "for you to gain a choice of one Terminus effect";
const TERMINUS_REWORDED_PHRASE = "you reach your Terminus";
function _normalizeTerminusText(cardContent) {
	for (const p of cardContent.querySelectorAll(".addendum p")) {
		if (p.textContent.includes(TERMINUS_JANKY_PHRASE)) {
			p.textContent = p.textContent.replace(TERMINUS_JANKY_PHRASE, TERMINUS_REWORDED_PHRASE);
		}
	}
}

// One PF2e addendum block: <div class="addendum"><h4>label</h4><p>…</p>…</div>,
// matching systems/pf2e/templates/items/partials/addendum.hbs. The extra
// `sky-essence` class lets the render hook recognise its own injected sections.
function _addendum(label, lines) {
	const body = lines.map(t => `<p>${t}</p>`).join("");
	return `<div class="addendum sky-essence"><h4>${label}</h4>${body}</div>`;
}

// Find the actor feat that carries Magic+'s essence-increase/leak description rule;
// its name is the heading Magic+ shows on fixed-cost cards (e.g. "Essence
// Spellcasting (Full)"). Falls back to a sensible default if not found.
function _findEssenceFeatName(actor) {
	for (const item of actor.items) {
		for (const rule of (item.system?.rules ?? [])) {
			if (rule.key !== "ItemAlteration" || rule.property !== "description") continue;
			const text = (rule.value ?? []).map(v => v?.text ?? "").join(" ");
			if (text.includes("increases your essence pool by 1")) return rule.label || item.name;
		}
	}
	return "Essence Spellcasting";
}

// The heading Magic+ shows on a fixed-cost cantrip draw card, taken from the actor's
// "Draw Cantrips" feat (found by its description rule). Falls back to a sensible default.
function _findDrawCantripsFeatName(actor) {
	for (const item of actor.items) {
		for (const rule of (item.system?.rules ?? [])) {
			if (rule.key !== "ItemAlteration" || rule.property !== "description") continue;
			const text = (rule.value ?? []).map(v => v?.text ?? "").join(" ");
			if (text.includes("begin your cycle from 0")) return rule.label || item.name;
		}
	}
	return "Draw Cantrips";
}

// Re-create the Draw Cantrips card section (Magic+ feat jNOZkBE8sd1UhH8o), which only
// renders for a fixed 2/3-action cantrip (its predicate needs a numeric cast:actions) and
// so drops for a variable cantrip. We resolve the essence-draw value the native template
// would have injected (`{actor|flags.pf2e.essence-draw}`) and stash the section on the
// message like the spend path, so the render hook re-applies it.
async function _storeCantripDrawAddendum(message, actor, draw) {
	const TextEditor = foundry.applications.ux.TextEditor.implementation;
	const label = _findDrawCantripsFeatName(actor);
	const text = `This cantrip sets your essence pool to ${draw}, allowing you to begin your cycle from 0. If you already have essence, you can increase your essence by 1.`;
	const html = await TextEditor.enrichHTML(_addendum(label, [text]), { relativeTo: actor });
	await message.setFlag(MODULE_ID, ESSENCE_ADDENDA_FLAG, [{ match: "begin your cycle from 0", html }]);
}

// The stage-aware line Magic+'s native bounded "Essence Spellcasting" description rule
// shows for a *clean* (2+ action) bounded cast, picked by the PRE-cast bounded-time stage
// and features (mirroring that rule's per-line predicates, dumped from feat 05Q5qj5dRPyt7sNj):
//   - 1st Draw + Second Draw feat -> points you at Second Draw to draw again
//   - 2nd Draw + Terminus feat    -> the Terminus of Bounded Might line ("provided you have
//                                    not leaked")
//   - otherwise (no further draw) -> "no longer able to cast spells this combat"
// UUIDs are reproduced verbatim from the native rule.
function _boundedCleanLine(rollOptions) {
	const stage1 = rollOptions.includes(`${BOUNDED_TIME_OPTION}:1`);
	const stage2 = rollOptions.includes(`${BOUNDED_TIME_OPTION}:2`);
	const secondDraw = rollOptions.includes("feature:second-draw");
	const terminus = rollOptions.includes("feature:terminus-of-bounded-might-feature");

	if (secondDraw && stage1) {
		return {
			text: "Casting this spell reduces your essence pool to 0! You are able to use @UUID[Compendium.pf2e-team-plus-magic.items.coQP9rX3bOAzF9W4]{Second Draw} to draw again this combat.",
			match: "to draw again this combat"
		};
	}
	if (terminus && stage2) {
		return {
			text: "Provided you have not leaked, you are able to use @UUID[Compendium.pf2e-team-plus-magic.misc.tS7kdCVx6wmAkQ6G]{Terminus of Bounded Might} to increase your essence above 1.",
			match: "increase your essence above 1"
		};
	}
	return {
		text: "Casting this spell reduces your essence pool to 0! You will be no longer able to cast spells this combat.",
		match: "no longer able to cast spells"
	};
}

// Card section for a bounded variable-cost non-cantrip cast. Magic+'s native bounded
// description rules are gated on a numeric `item:cast:actions`, so they drop for a variable
// cost — we re-create the matching line here, verbatim from the native rule:
//   - leak (1 action)  -> the single "causes an essence leak" line
//   - clean (2+)        -> the stage-aware line (`_boundedCleanLine`), incl. the Terminus line
async function _storeBoundedSpellAddendum(message, actor, leak, rollOptions) {
	const TextEditor = foundry.applications.ux.TextEditor.implementation;
	const label = _findEssenceFeatName(actor);
	const advanceLink = `@UUID[${ADVANCE_ESSENCE_UUID}]{Advance Essence}`;
	const { text, match } = leak
		? { text: "Casting this spell causes an essence leak, reducing you to 0 essence!", match: "causes an essence leak" }
		: _boundedCleanLine(rollOptions);
	const html = await TextEditor.enrichHTML(_addendum(label, [text, advanceLink]), { relativeTo: actor });
	await message.setFlag(MODULE_ID, ESSENCE_ADDENDA_FLAG, [{ match, html }]);
}

// Find the actor's Terminus feat (a feat with a selfEffect carrying the Terminus
// description rule); returns its name + the effect UUID, or null.
function _findTerminusFeat(actor) {
	for (const item of actor.items) {
		const uuid = item.system?.selfEffect?.uuid;
		if (!uuid) continue;
		for (const rule of (item.system?.rules ?? [])) {
			if (rule.key !== "ItemAlteration" || rule.property !== "description") continue;
			const text = (rule.value ?? []).map(v => v?.text ?? "").join(" ");
			if (text.includes("Terminus effect")) return { name: item.name, uuid };
		}
	}
	return null;
}

// Returns true to leak (1 action), false to draw (2+ actions), or null if the
// dialog was dismissed. A spell whose minimum cost is 2+ actions can never be a
// 1-action leak, so we skip the prompt and report a draw.
async function _promptLeakOrDraw(spell, range) {
	if (range && range.min >= 2) return false;
	try {
		const result = await foundry.applications.api.DialogV2.wait({
			window: { title: "Essence Casting — Actions Spent" },
			position: { width: 360 },
			content: `
				<div class="sky-essence-prompt">
					<p>How many actions did you spend casting <strong>${foundry.utils.escapeHTML?.(spell.name) ?? spell.name}</strong>?</p>
					<p class="sky-essence-hint">1 action leaks your Essence Pool to 0; 2+ actions draw Essence.</p>
				</div>`,
			buttons: [
				{ action: "leak", label: "1 Action", callback: () => true },
				{ action: "draw", label: "2+ Actions", callback: () => false }
			],
			rejectClose: false
		});
		return typeof result === "boolean" ? result : null;
	} catch {
		return null;
	}
}

// Returns true if the cantrip was cast with 2+ actions (draw), false for 1 action (no
// essence effect — cantrips don't leak), or null if the dialog was dismissed. A cantrip
// whose minimum cost is 2+ actions always draws, so we skip the prompt.
async function _promptCantripActions(spell, range) {
	if (range && range.min >= 2) return true;
	try {
		const result = await foundry.applications.api.DialogV2.wait({
			window: { title: "Essence Casting — Actions Spent" },
			position: { width: 360 },
			content: `
				<div class="sky-essence-prompt">
					<p>How many actions did you spend casting <strong>${foundry.utils.escapeHTML?.(spell.name) ?? spell.name}</strong>?</p>
					<p class="sky-essence-hint">A cantrip draws Essence only when cast with 2+ actions; 1 action has no effect on your pool.</p>
				</div>`,
			buttons: [
				{ action: "single", label: "1 Action", callback: () => false },
				{ action: "draw", label: "2+ Actions", callback: () => true }
			],
			rejectClose: false
		});
		return typeof result === "boolean" ? result : null;
	} catch {
		return null;
	}
}

// Magic+'s Terminus-cantrip confirmation (drawing past max for a cycle-terminus caster).
// Returns true to proceed, false to decline (or on error).
async function _confirmTerminusCantrip() {
	try {
		return await foundry.applications.api.DialogV2.confirm({
			window: { title: "Terminus Cantrip" },
			position: { width: 400 },
			content: "<p>Casting this cantrip will cause you to reach your Terminus and reduce your essence to 0.</p><p>Are you sure you want to do that?</p>"
		});
	} catch {
		return false;
	}
}

// =============================================================================
// Tweak: Incantation Mode
//
// Out of combat, essence casters have no spell slots — they cast via Incantations
// (Magic+'s class feature). Each maintained incantation reduces essence draw and
// pool max by 1, tracked by the "Effect: Maintaining Incantations" counter effect.
// Magic+ ships that effect but never applies or advances it automatically.
//
// This tweak adds a per-character Incantation toggle to the spellcasting tab. While
// it's on and the actor isn't in combat, casting an essence spell applies the effect
// (counter 1) or, if already present, bumps the counter by 1. The essence pool draw
// is left entirely to Magic+ — out of combat that automation already does the right
// thing, so we only manage the incantation counter.
// =============================================================================

// "Effect: Maintaining Incantations" in Magic+'s items pack (badge counter, max 9).
const MAINTAINING_INCANTATIONS_UUID = "Compendium.pf2e-team-plus-magic.items.Item.mU4bcDt3wpVZ1cuE";
const MAINTAINING_INCANTATIONS_NAME = "Effect: Maintaining Incantations";
const INCANTATION_FLAG = "incantationMode";

// Magic+'s "Incantation Mastery" feat (lvl 7+): casting an incantation for a spell of
// lower rank than your current essence draw, with no duration, costs no essence — i.e.
// it doesn't advance the Maintaining Incantations counter. Detected by feat + cast rank
// vs. essence draw + duration, and the counter bump is skipped entirely.
const INCANTATION_MASTERY_UUID = "Compendium.pf2e-team-plus-magic.items.Item.oshpc0l8UMOmhTq0";
const INCANTATION_MASTERY_NAME = "Incantation Mastery";

let _incantationCastHookId = null;
let _incantationSheetHookId = null;
let _incantationCombatStartHookId = null;
let _incantationCombatEndHookId = null;

registerTweak({
	id: "incantationMode",
	name: "Incantation Mode",
	hint: "Adds a per-character Incantation indicator to the spellcasting tab. While you're out of combat, casting an essence spell applies Magic+'s \"Maintaining Incantations\" effect at counter 1 and bumps the counter by 1 on each further cast. The toggle is automatic: off in combat, on out of combat.",
	default: true,
	onEnable() {
		if (!_incantationCastHookId) {
			_incantationCastHookId = Hooks.on("createChatMessage", _onIncantationCast);
		}
		if (!_incantationSheetHookId) {
			_incantationSheetHookId = Hooks.on("renderCharacterSheetPF2e", _onRenderCharacterSheet);
		}
		if (!_incantationCombatStartHookId) {
			_incantationCombatStartHookId = Hooks.on("combatStart", _onCombatStartIncantation);
		}
		if (!_incantationCombatEndHookId) {
			_incantationCombatEndHookId = Hooks.on("deleteCombat", _onCombatEndIncantation);
		}
	},
	onDisable() {
		if (_incantationCastHookId) {
			Hooks.off("createChatMessage", _incantationCastHookId);
			_incantationCastHookId = null;
		}
		if (_incantationSheetHookId) {
			Hooks.off("renderCharacterSheetPF2e", _incantationSheetHookId);
			_incantationSheetHookId = null;
		}
		if (_incantationCombatStartHookId) {
			Hooks.off("combatStart", _incantationCombatStartHookId);
			_incantationCombatStartHookId = null;
		}
		if (_incantationCombatEndHookId) {
			Hooks.off("deleteCombat", _incantationCombatEndHookId);
			_incantationCombatEndHookId = null;
		}
	}
});

// Incantation Mode is driven by combat state, not manual toggling: ticked OFF when an
// encounter begins, back ON when it ends. GM client only, to avoid every client racing
// to write the same flag. Combatants that aren't essence casters are skipped.
function _setIncantationForCombat(combat, value) {
	if (!game.user.isGM) return;
	for (const combatant of combat.combatants) {
		const actor = combatant.actor;
		if (!actor?.getRollOptions?.().includes("feature:essence-pool")) continue;
		if (!!actor.getFlag(MODULE_ID, INCANTATION_FLAG) === value) continue;
		actor.setFlag(MODULE_ID, INCANTATION_FLAG, value);
	}
}

function _onCombatStartIncantation(combat) {
	_setIncantationForCombat(combat, false);
}

function _onCombatEndIncantation(combat) {
	_setIncantationForCombat(combat, true);
}

// True if the actor is a combatant in any started encounter.
function _actorInCombat(actor) {
	return game.combats?.some(c => c.started && c.combatants.some(cb => cb.actorId === actor.id)) ?? false;
}

// Find-or-create the shared header row prepended to the spellcasting tab's
// spell-collections. Both the Incantation Mode toggle and the Refocus button live
// in here so they share one line (toggle left, button right) regardless of which
// tweak's render hook fires first.
function _spellTabHeader(collections) {
	let header = collections.querySelector(".sky-spell-tab-header");
	if (!header) {
		header = document.createElement("div");
		header.className = "sky-spell-tab-header";
		collections.prepend(header);
	}
	return header;
}

// Inject the per-actor Incantation toggle (a single checkbox) just below the
// spellcasting tab's sub-nav. Registered via renderCharacterSheetPF2e like Magic+'s
// own controls, and only shown for essence casters (feature:essence-pool).
function _onRenderCharacterSheet(sheet, html) {
	const actor = sheet.actor;
	if (!actor?.getRollOptions().includes("feature:essence-pool")) return;

	const root = sheet.element?.[0] ?? sheet.element ?? (html instanceof HTMLElement ? html : html?.[0]);
	const collections = root?.querySelector?.('.tab.spellcasting .spell-collections');
	if (!collections || collections.querySelector(".sky-incantation-toggle")) return;

	// Lazy-persist the lock the first time an essence caster's sheet renders, so it
	// doesn't take a first combat to write the flag. GM-only and guarded on undefined,
	// so it writes exactly once (the re-render it triggers sees a defined flag).
	const stored = actor.getFlag(MODULE_ID, INCANTATION_FLAG);
	if (stored === undefined && game.user.isGM) {
		actor.setFlag(MODULE_ID, INCANTATION_FLAG, !_actorInCombat(actor));
	}

	// Display state is automatic: the stored flag if set, otherwise on while out of
	// combat. The checkbox is a locked status indicator — combat start/end drives it.
	const active = stored ?? !_actorInCombat(actor);
	const label = document.createElement("label");
	label.className = "sky-incantation-toggle";
	label.dataset.tooltip = "Incantation Mode (automatic): on out of combat, off during an encounter. Out of combat, each essence spell you cast applies/stacks the Maintaining Incantations effect.";
	label.innerHTML = `<input type="checkbox" disabled${active ? " checked" : ""}> <span><i class="fa-solid fa-fw fa-scroll"></i> Incantation Mode</span>`;
	// Prepend within the shared header so the toggle stays on the left even if the
	// Refocus button injected first.
	_spellTabHeader(collections).prepend(label);
}

// On an out-of-combat essence cast while Incantation Mode is on, apply or advance
// the Maintaining Incantations effect. Pool changes are left to Magic+.
async function _onIncantationCast(message) {
	// Only the casting client mutates, to avoid the GM double-applying.
	if (message.author?.id !== game.userId) return;

	const castingId = message.flags?.pf2e?.casting?.id;
	if (!castingId) return;

	const spell = message.item;
	if (!spell || spell.type !== "spell") return;
	if (spell.system.traits?.value?.includes("cantrip")) return;

	const actor = message.actor;
	if (!actor) return;
	// Default-on out of combat: only an explicit `false` flag suppresses.
	if (actor.getFlag(MODULE_ID, INCANTATION_FLAG) === false) return;
	if (_actorInCombat(actor)) return;

	const entry = actor.spellcasting?.get(castingId);
	const rules = entry?.system?.rules ?? [];
	if (!rules.some(r => r.value === "essence")) return;

	// Incantation Mastery: a low-rank, durationless incantation is free — skip the bump.
	if (_incantationMasteryFree(actor, spell, message)) return;

	await _applyOrAdvanceIncantation(actor);
}

// True when Incantation Mastery makes this incantation free (no counter advance): the
// actor has the feat, the cast rank is below their current essence draw, and the spell
// has no duration. Cast rank comes from the message origin (pf2e.mjs), falling back to
// the spell's own rank; "no duration" mirrors PF2e's empty-value/non-sustained check.
function _incantationMasteryFree(actor, spell, message) {
	const hasMastery = actor.items?.some?.(
		i => i.sourceId === INCANTATION_MASTERY_UUID || i.name === INCANTATION_MASTERY_NAME
	);
	if (!hasMastery) return false;

	const draw = Number(actor.flags?.pf2e?.["essence-draw"]) || 0;
	const castRank = Number(message.flags?.pf2e?.origin?.castRank ?? spell.rank) || 0;
	if (!(castRank > 0 && castRank < draw)) return false;

	const duration = spell.system?.duration ?? {};
	const hasDuration = !!duration.sustained || !!(duration.value && String(duration.value).trim());
	return !hasDuration;
}

// Create the Maintaining Incantations effect at counter 1, or bump an existing one
// by 1 (capped at its badge max).
async function _applyOrAdvanceIncantation(actor) {
	const existing = actor.itemTypes.effect.find(
		e => e.sourceId === MAINTAINING_INCANTATIONS_UUID || e.name === MAINTAINING_INCANTATIONS_NAME
	);

	if (existing) {
		const badge = existing.system.badge ?? {};
		const next = Math.min((badge.value ?? 1) + 1, badge.max ?? 9);
		if (next !== badge.value) await existing.update({ "system.badge.value": next });
		return;
	}

	const source = (await fromUuid(MAINTAINING_INCANTATIONS_UUID))?.toObject();
	if (!source) return;
	foundry.utils.setProperty(source, "system.badge.value", 1);
	await actor.createEmbeddedDocuments("Item", [source]);
}

// =============================================================================
// Tweak: Essence Pool — Combat-Only
//
// The Essence Pool is a combat resource: it only fills during encounters, and out
// of combat essence casters use Incantations instead. Magic+ doesn't enforce this,
// so without help the pool can be advanced out of combat and lingers after a fight.
// This tweak clears the pool to 0 when an encounter ends and blocks any increase
// while the actor is out of combat (decreases/leaks still pass through).
// =============================================================================

const ESSENCE_POOL_SLUG = "essence-pool";
const UPDATE_RESOURCE_TARGET = "CONFIG.PF2E.Actor.documentClasses.character.prototype.updateResource";

// Magic+'s "Initial Draw" class feature (level 5+): "you draw an amount of essence up
// to your essence draw when you roll initiative." Magic+ only posts an initiative Note
// for it — there's no pool automation — so we fill the pool ourselves at combat start.
const INITIAL_DRAW_UUID = "Compendium.pf2e-team-plus-magic.items.Item.cYHvzy96aWk5n8yC";
const INITIAL_DRAW_NAME = "Initial Draw";
// Option flag marking our own deliberate pool fill so the out-of-combat increase-block
// lets it through (combatStart fires before `started` settles, so _actorInCombat can
// still read false at draw time).
const INITIAL_DRAW_OPTION = "skyInitialDraw";

let _combatStartHookId = null;
let _combatEndHookId = null;
let _essencePoolHookId = null;
let _restoreRenderHookId = null;

// Both the combat-only and Second-Draw-leak tweaks need to intercept the pool write
// (`updateResource`). libWrapper allows a package only one registration per target, so
// they share a single wrapper, refcounted by how many of them are enabled, and each
// gates its own behavior on its own "active" flag.
let _updateResourceRefcount = 0;
let _combatOnlyActive = false;
let _leakActive = false;

function _registerUpdateResourceWrapper() {
	if (typeof libWrapper !== "function") {
		// Without libWrapper the essence-pool wrapper can't install, so "Essence Pool:
		// Combat-Only" and "Bounded Second Draw Leak" would silently do nothing. Surface
		// it loudly instead of failing quietly. (module.json also declares the dependency.)
		console.error(`${MODULE_ID} | libWrapper is not active — the Essence Pool tweaks (Combat-Only / Second Draw Leak) cannot function. Install and enable the libWrapper module.`);
		ui.notifications?.error("Sky's 2e Tweaks: the libWrapper module is required for the Essence Pool tweaks but isn't active.");
		return;
	}
	if (_updateResourceRefcount === 0) {
		libWrapper.register(MODULE_ID, UPDATE_RESOURCE_TARGET, _wrapUpdateResource, "WRAPPER");
	}
	_updateResourceRefcount++;
}

function _unregisterUpdateResourceWrapper() {
	_updateResourceRefcount = Math.max(0, _updateResourceRefcount - 1);
	if (_updateResourceRefcount === 0 && typeof libWrapper === "function") {
		libWrapper.unregister(MODULE_ID, UPDATE_RESOURCE_TARGET);
	}
}

registerTweak({
	id: "essenceCombatOnly",
	name: "Essence Pool: Combat-Only",
	hint: "Treats the Essence Pool as a combat-only resource: fills it to your essence draw at the start of an encounter (Initial Draw), clears it to 0 when the encounter ends, and prevents it from increasing while you're out of combat (out of combat you cast via Incantations).",
	default: true,
	onEnable() {
		if (!_combatStartHookId) {
			_combatStartHookId = Hooks.on("combatStart", _onCombatStartDraw);
		}
		if (!_combatEndHookId) {
			_combatEndHookId = Hooks.on("deleteCombat", _onCombatEnd);
		}
		if (!_essencePoolHookId) {
			_essencePoolHookId = Hooks.on("updateItem", _onEssencePoolUpdate);
		}
		if (!_restoreRenderHookId) {
			_restoreRenderHookId = Hooks.on("renderCharacterSheetPF2e", _onRenderRestoreSlots);
		}
		if (!_combatOnlyActive) {
			_combatOnlyActive = true;
			_registerUpdateResourceWrapper();
		}
	},
	onDisable() {
		if (_combatStartHookId) {
			Hooks.off("combatStart", _combatStartHookId);
			_combatStartHookId = null;
		}
		if (_combatEndHookId) {
			Hooks.off("deleteCombat", _combatEndHookId);
			_combatEndHookId = null;
		}
		if (_essencePoolHookId) {
			Hooks.off("updateItem", _essencePoolHookId);
			_essencePoolHookId = null;
		}
		if (_restoreRenderHookId) {
			Hooks.off("renderCharacterSheetPF2e", _restoreRenderHookId);
			_restoreRenderHookId = null;
		}
		if (_combatOnlyActive) {
			_combatOnlyActive = false;
			_unregisterUpdateResourceWrapper();
		}
	}
});

// On combat start, fill each Initial Draw combatant's Essence Pool up to their essence
// draw (flags.pf2e.essence-draw). GM-only; never lowers a pool that's already higher.
// `started` is true by the time combatStart fires, so the combat-only block allows it.
function _onCombatStartDraw(combat) {
	if (!game.user.isGM) return;
	for (const combatant of combat.combatants) {
		const actor = combatant.actor;
		if (!actor) continue;
		const hasInitialDraw = actor.items?.some?.(
			i => i.sourceId === INITIAL_DRAW_UUID || i.name === INITIAL_DRAW_NAME
		);
		if (!hasInitialDraw) continue;
		const draw = Number(actor.flags?.pf2e?.["essence-draw"]) || 0;
		if (draw <= 0) continue;
		const pool = actor.getResource?.(ESSENCE_POOL_SLUG);
		if (!pool || pool.value >= draw) continue;
		actor.updateResource(ESSENCE_POOL_SLUG, draw, { render: true, [INITIAL_DRAW_OPTION]: true });
	}
}

// Shared Essence Pool write interceptor for the combat-only and Second-Draw-leak
// tweaks. Each stage is gated on its own active flag so the wrapper does only the work
// of whichever tweaks are currently enabled.
function _wrapUpdateResource(wrapped, resource, value, options) {
	const isEssencePool = String(resource).toLowerCase() === ESSENCE_POOL_SLUG;

	// --- Second Draw leak correction ---
	// After a Bounded caster leaks (a sub-2-action essence cast empties the pool), the
	// next pool *raise* is their 2nd Draw, which Magic+ over-fills by the Second Draw +1.
	// Drop that one raise by 1 and consume the leak. Skip our own Initial Draw fill.
	if (_leakActive && isEssencePool && !options?.[INITIAL_DRAW_OPTION] && _essenceLeaked.has(this.id)) {
		const current = this.getResource?.(ESSENCE_POOL_SLUG)?.value ?? 0;
		if (typeof value === "number" && value > current) {
			_essenceLeaked.delete(this.id);
			value = Math.max(0, value - 1);
			_ld("leak consumed: 2nd Draw reduced by 1", { actor: this.name, to: value });
		}
	}

	// --- Combat-only block ---
	// Block Essence Pool increases while the actor is out of combat. Decreases (e.g. a
	// leak back to 0) and every in-combat change pass through untouched.
	if (_combatOnlyActive) {
		if (options?.[INITIAL_DRAW_OPTION]) return wrapped(resource, value, options);
		if (isEssencePool && !_actorInCombat(this)) {
			const current = this.getResource?.(ESSENCE_POOL_SLUG)?.value ?? 0;
			if (value > current) return wrapped(resource, current, options);
		}
	}
	return wrapped(resource, value, options);
}

// Clear every combatant's Essence Pool to 0 when an encounter ends. Runs on the GM
// client only, so the writes happen once.
function _onCombatEnd(combat) {
	if (!game.user.isGM) return;
	for (const combatant of combat.combatants) {
		const actor = combatant.actor;
		const pool = actor?.getResource?.(ESSENCE_POOL_SLUG);
		if (pool && pool.value !== 0) actor.updateResource(ESSENCE_POOL_SLUG, 0, { render: true });
	}
}

// The actor's Essence-casting spellcasting entries (regular prepared/spontaneous whose
// toggle marked them essence — the same `essence` RollOption rule Magic+ keys on).
function _essenceEntries(actor) {
	const entries = actor?.spellcasting?.regular ?? [];
	return entries.filter(e => (e.system?.rules ?? []).some(r => r.value === "essence"));
}

// Magic+'s updateEssencePool expends (crosses out) every essence spell slot the pool
// can't afford (`pool.value < rank`). Out of combat we hold the pool at 0, so it strikes
// *every* ranked slot, and since Magic+ only re-evaluates on a pool change the struck
// state then persists out of combat. We undo that whenever the actor is out of combat.
//
// `force` writes unconditionally (used right at combat end, where Magic+'s fresh
// cross-out hasn't landed in the in-memory slot data yet, so an "is it expended?" read
// would be stale). Without it we only write when a slot is actually expended, so it's
// safe to call from the sheet-render hook: the write re-renders, the second pass finds
// nothing to fix, and the loop stops. GM-only; writes to entry items (not the pool), so
// it never re-triggers Magic+'s pool handler.
function _restoreEssenceSlots(actor, { force = false } = {}) {
	if (!game.user.isGM || !actor) return;
	if (_actorInCombat(actor)) return;
	const updates = [];
	for (const entry of _essenceEntries(actor)) {
		const obj = { _id: entry.id };
		let touched = false;
		for (const slot in entry.system.slots) {
			const rank = Number(slot.replace("slot", ""));
			if (rank === 0) continue;
			const slotData = entry.system.slots[slot];
			if (entry.isPrepared) {
				const prepared = slotData.prepared ?? [];
				if (force || prepared.some(x => x.expended)) {
					obj[`system.slots.${slot}.prepared`] = prepared.map(x => ({ ...x, expended: false }));
					touched = true;
				}
			} else if (entry.isSpontaneous) {
				if (force || (slotData.value ?? 0) < slotData.max) {
					obj[`system.slots.${slot}.value`] = slotData.max;
					touched = true;
				}
			}
		}
		if (touched) updates.push(obj);
	}
	if (updates.length) actor.updateEmbeddedDocuments("Item", updates);
}

// Immediate un-cross at combat end: our own pool-clear fires this essence-pool
// updateItem, and Magic+'s same-hook handler crosses everything out. Force-restore so we
// win regardless of which hook ran first (the render backstop below covers the already-
// settled case this can't see, e.g. a fresh page load with the pool long since at 0).
function _onEssencePoolUpdate(feat) {
	if (feat?.slug !== ESSENCE_POOL_SLUG || !feat.actor) return;
	_restoreEssenceSlots(feat.actor, { force: true });
}

// Backstop: restore slots whenever an essence caster's sheet renders out of combat.
// Idempotent (no `force`), so it writes at most once per crossed-out state and converges.
function _onRenderRestoreSlots(sheet) {
	_restoreEssenceSlots(sheet?.actor);
}

// =============================================================================
// Tweak: Bounded Essence — Combat Stage
//
// Bounded essence casters track their draw with Magic+'s `bounded-time` toggle
// (0 = Out of Essence, 1/2/3 = 1st/2nd/3rd Draw). Magic+ advances 1→2→3→0 on each
// essence-spell cast but never *enters* stage 1 (it only ever toggles 0/2/3), so
// players have to arm the cycle by hand. We set it to 1st Draw at combat start and
// back to Out of Essence when the encounter ends, leaving the in-between to Magic+.
// =============================================================================

const BOUNDED_TIME_OPTION = "bounded-time";
const BOUNDED_CASTER_OPTION = "essence-caster:bounded";

let _boundedStartHookId = null;
let _boundedEndHookId = null;

registerTweak({
	id: "boundedCombatStage",
	name: "Bounded Essence: Combat Stage",
	hint: "Automates the bounded-time draw stage for Bounded essence casters: sets it to 1st Draw when an encounter starts and back to Out of Essence when it ends (Magic+ already advances the stage on each cast).",
	default: true,
	onEnable() {
		if (!_boundedStartHookId) {
			_boundedStartHookId = Hooks.on("combatStart", _onBoundedCombatStart);
		}
		if (!_boundedEndHookId) {
			_boundedEndHookId = Hooks.on("deleteCombat", _onBoundedCombatEnd);
		}
	},
	onDisable() {
		if (_boundedStartHookId) {
			Hooks.off("combatStart", _boundedStartHookId);
			_boundedStartHookId = null;
		}
		if (_boundedEndHookId) {
			Hooks.off("deleteCombat", _boundedEndHookId);
			_boundedEndHookId = null;
		}
	}
});

function _onBoundedCombatStart(combat) {
	_setBoundedStageForCombat(combat, "1");
}

function _onBoundedCombatEnd(combat) {
	_setBoundedStageForCombat(combat, "0");
}

// GM-only: set each Bounded essence caster combatant's bounded-time stage, skipping
// any already on that stage. Mirrors Magic+'s own toggle call
// (`toggleRollOption("all", "bounded-time", null, true, n)`).
function _setBoundedStageForCombat(combat, stage) {
	if (!game.user.isGM) return;
	for (const combatant of combat.combatants) {
		const actor = combatant.actor;
		const opts = actor?.getRollOptions?.();
		if (!opts?.includes(BOUNDED_CASTER_OPTION)) continue;
		if (opts.includes(`${BOUNDED_TIME_OPTION}:${stage}`)) continue;
		actor.toggleRollOption("all", BOUNDED_TIME_OPTION, null, true, stage);
	}
}

// =============================================================================
// Tweak: Bounded Essence — Second Draw leak suppression
//
// A Bounded essence caster's Second Draw feat draws +1 essence "if you didn't
// experience an essence leak" this encounter. Magic+ models the +1 with an
// ActiveEffectLike on the feat that adds 1 to `flags.pf2e.essence-draw` whenever
// the actor is at `bounded-time:2` (2nd Draw) — with no leak condition at all. So
// when you reach 2nd Draw via a *leak* (a sub-2-action essence cast that drops you
// to 0), the next Draw Cantrip still reads the +1'd draw and over-draws by one.
//
// Fix (in-memory, write-free): we track the leak state for the current encounter in
// an in-memory Set of actor ids and correct the pool *at the write*. When a Bounded
// caster leaks, we add their id to the Set. Then a single shared libWrapper on
// `updateResource` (see `_wrapUpdateResource`) watches for that actor's next pool
// *raise* — their 2nd Draw — and drops it by 1, consuming the leak. The Set is
// cleared at every encounter boundary.
//
// Why in-memory + a pool-write correction instead of mutating the feat's rules: two
// earlier rule-element builds (a roll-option/predicate gate, then a commuting
// subtract AEL) either never netted out or, worse, the per-cast `feat.update` to
// add/remove the rule fed a render→update cycle that flooded the server with writes
// and survived a page reload. This design does ZERO document writes in normal
// operation, so it cannot loop, and it intercepts the exact `updateResource` call
// Magic+ makes *after* the chat card is built — so there's no timing race with the
// card text either (the corrected pool value is what gets written).
//
// `cleanupLeakRules` is a one-time manual repair (owner-only, `{render:false}`) that
// strips leftover artifacts from those earlier builds — the inert subtract AEL, the
// legacy `essence-leak` RollOption, and the `{not: essence-leak}` predicate splice —
// so upgraded feats return to clean Magic+ behavior.
// =============================================================================

const ESSENCE_LEAK_OPTION = "essence-leak";
const LEAK_SUPPRESS_LABEL = "sky-2e-tweaks-leak-suppress";

// Encounter-scoped, per-client leak state: actor ids that have leaked and are owed a
// −1 correction on their next pool raise (the 2nd Draw). Populated by detection on
// the caster client, consumed by `_wrapUpdateResource`, cleared at encounter bounds.
const _essenceLeaked = new Set();

let _leakCastHookId = null;
let _leakStartHookId = null;
let _leakEndHookId = null;

registerTweak({
	id: "boundedSecondDrawLeak",
	name: "Bounded Essence: Second Draw Leak",
	hint: "Fixes the Bounded Second Draw +1: it now only applies when you haven't leaked this encounter. After an essence leak, your second Draw Cantrip draws its normal amount instead of one too many.",
	default: true,
	onEnable() {
		if (!_leakCastHookId) {
			_leakCastHookId = Hooks.on("createChatMessage", _onBoundedEssenceCast);
		}
		if (!_leakStartHookId) {
			_leakStartHookId = Hooks.on("combatStart", _onLeakCombatBoundary);
		}
		if (!_leakEndHookId) {
			_leakEndHookId = Hooks.on("deleteCombat", _onLeakCombatBoundary);
		}
		if (!_leakActive) {
			_leakActive = true;
			_registerUpdateResourceWrapper();
		}
	},
	onDisable() {
		if (_leakCastHookId) {
			Hooks.off("createChatMessage", _leakCastHookId);
			_leakCastHookId = null;
		}
		if (_leakStartHookId) {
			Hooks.off("combatStart", _leakStartHookId);
			_leakStartHookId = null;
		}
		if (_leakEndHookId) {
			Hooks.off("deleteCombat", _leakEndHookId);
			_leakEndHookId = null;
		}
		if (_leakActive) {
			_leakActive = false;
			_essenceLeaked.clear();
			_unregisterUpdateResourceWrapper();
		}
	}
});

// The Second Draw feat is the item carrying the "+1 essence-draw at bounded-time:2"
// ActiveEffectLike. Identify it by that rule signature rather than a slug/name so we
// stay robust to Magic+ renaming it. (Used by inspect + the one-time cleanup helper.)
function _findSecondDrawAEL(rules) {
	return (rules ?? []).find(r =>
		r.key === "ActiveEffectLike"
		&& r.path === "flags.pf2e.essence-draw"
		&& r.mode === "add"
		&& Array.isArray(r.predicate)
		&& r.predicate.includes(`${BOUNDED_TIME_OPTION}:2`)
	);
}

function _findSecondDrawFeat(actor) {
	for (const item of actor.items) {
		if (_findSecondDrawAEL(item.system?.rules)) return item;
	}
	return null;
}

// Toggle verbose leak-detection logging from the console:
//   game.modules.get("sky-2e-tweaks").api.leakDebug(true)
let _LEAK_DEBUG = false;
function leakDebug(on = true) { _LEAK_DEBUG = !!on; return `leak debug ${_LEAK_DEBUG ? "ON" : "OFF"}`; }
function _ld(stage, extra) {
	if (_LEAK_DEBUG) console.log(`%c[sky-leak] ${stage}`, "color:#c80", extra ?? "");
}

// Mark an essence leak when a Bounded essence caster casts a sub-2-action essence
// spell (reaction / free / 1 action) — Magic+'s own definition of a leak. Variable
// "1 to X" and 2+ action casts are clean draws and don't leak. Caster-client only,
// and write-free: it only records the actor id in the in-memory Set.
function _onBoundedEssenceCast(message) {
	if (message.author?.id !== game.userId) return _ld("bail: not my message", { author: message.author?.id, me: game.userId });

	const castingId = message.flags?.pf2e?.casting?.id;
	if (!castingId) return; // not a spell card; silent (fires for every chat message)

	const spell = message.item;
	if (!spell || spell.type !== "spell") return _ld("bail: no spell item", spell?.type);

	const actor = message.actor;
	if (!actor?.spellcasting || !actor.isOwner) return _ld("bail: actor/owner", { hasSpellcasting: !!actor?.spellcasting, isOwner: actor?.isOwner });

	// Encounter-scoped mechanic — only track during combat.
	if (!_actorInCombat(actor)) return _ld("bail: not in combat");

	const rollOptions = actor.getRollOptions();
	if (!rollOptions.includes(BOUNDED_CASTER_OPTION)) return _ld("bail: not bounded caster", rollOptions.filter(o => o.startsWith("essence-caster")));
	if (rollOptions.includes("essence-blocked")) return _ld("bail: essence-blocked");

	const entry = actor.spellcasting.get(castingId);
	if (!entry) return _ld("bail: entry not found", castingId);
	if (!(entry.system?.rules ?? []).some(r => r.value === "essence")) return _ld("bail: entry not essence-marked", entry.name);

	// Cantrips draw essence, they don't leak it.
	if (spell.system.traits?.value?.includes("cantrip")) return _ld("bail: cantrip (draws, not leaks)", spell.name);

	const time = spell.system.time?.value;
	const leaked = time === "reaction" || time === "free" || time === "1";
	_ld("essence cast seen", { spell: spell.name, time, leaked });
	if (!leaked) return;

	// Record the leak. The −1 correction lands on the actor's next pool *raise* (the
	// 2nd Draw) inside `_wrapUpdateResource`, which consumes the id.
	_essenceLeaked.add(actor.id);
	_ld("LEAK MARKED", { actor: actor.name, owed: true });
}

// Clear leak state at every encounter boundary (start and end). Write-free and
// client-local, so no GM guard is needed — just drop each combatant's id.
function _onLeakCombatBoundary(combat) {
	for (const combatant of combat.combatants) {
		const id = combatant.actor?.id;
		if (id) _essenceLeaked.delete(id);
	}
}

// One-time manual repair for feats touched by the earlier rule-element builds. Strips
// our inert subtract AEL, the legacy `essence-leak` RollOption, and the
// `{not: essence-leak}` predicate splice so the feat returns to clean Magic+ behavior.
// Owner-only; writes with `{render:false}` to avoid kicking the sheet. Run once via:
//   game.modules.get("sky-2e-tweaks").api.cleanupLeakRules(_token.actor)
async function cleanupLeakRules(actor = canvas.tokens.controlled[0]?.actor) {
	if (!actor) return console.warn("sky-2e-tweaks: no actor (select a token or pass one).");
	if (!actor.isOwner) return console.warn("sky-2e-tweaks: not the owner of this actor.");
	const feat = _findSecondDrawFeat(actor);
	if (!feat) return console.warn("sky-2e-tweaks: no Second Draw feat found on this actor.");

	const rules = foundry.utils.deepClone(feat.system.rules ?? []);
	let changed = false;

	// Remove our inert subtract leak-suppress rule and the legacy essence-leak RollOption.
	for (let i = rules.length - 1; i >= 0; i--) {
		const r = rules[i];
		if (r.key === "ActiveEffectLike" && r.label === LEAK_SUPPRESS_LABEL) { rules.splice(i, 1); changed = true; continue; }
		if (r.key === "RollOption" && r.option === ESSENCE_LEAK_OPTION) { rules.splice(i, 1); changed = true; }
	}
	// Strip the legacy `{not: essence-leak}` predicate splice from the +1 AEL.
	const ael = _findSecondDrawAEL(rules);
	if (ael && Array.isArray(ael.predicate)) {
		const cleaned = ael.predicate.filter(p => !(p && typeof p === "object" && p.not === ESSENCE_LEAK_OPTION));
		if (cleaned.length !== ael.predicate.length) { ael.predicate = cleaned; changed = true; }
	}

	if (changed) await feat.update({ "system.rules": rules }, { render: false });
	const msg = changed ? "sky-2e-tweaks: cleaned leftover leak rules." : "sky-2e-tweaks: nothing to clean (feat already clean).";
	console.log(msg);
	return msg;
}

// Diagnostic: dump the live leak state for an actor. Run in console as
//   game.modules.get("sky-2e-tweaks").api.inspectLeak(_token.actor)
function inspectLeak(actor = canvas.tokens.controlled[0]?.actor) {
	if (!actor) return console.warn("sky-2e-tweaks: no actor (select a token or pass one).");
	const feat = _findSecondDrawFeat(actor);
	const opts = actor.getRollOptions();
	const rules = feat?.system?.rules ?? [];
	const summary = {
		actor: actor.name,
		secondDrawFeat: feat ? `${feat.name} (${feat.id})` : "NOT FOUND",
		leakedOwed: _essenceLeaked.has(actor.id),
		boundedTime: opts.filter(o => o.startsWith(`${BOUNDED_TIME_OPTION}:`)),
		essenceDrawFlag: actor.flags?.pf2e?.["essence-draw"],
		pool: (() => { const p = actor.getResource("essence-pool"); return p ? `${p.value}/${p.max}` : "none"; })(),
		legacyLeakOption: opts.includes(ESSENCE_LEAK_OPTION),
		essenceDrawAELs: rules.filter(r => r.key === "ActiveEffectLike" && r.path === "flags.pf2e.essence-draw")
			.map(r => ({ mode: r.mode, value: r.value, predicate: r.predicate, label: r.label }))
	};
	console.log("%c[sky-2e-tweaks] leak inspect", "font-weight:bold", summary);
	console.log("Second Draw feat rules:", foundry.utils.deepClone(rules));
	return summary;
}

// =============================================================================
// Tweak: Essence Spell Counters
//
// On a spellcasting entry marked Essence, the per-rank header counter ("2 / 5",
// etc.) loses its usual meaning — essence spells aren't expended per rank; the pool
// governs casting. We repurpose it: drop the current/charges side and relabel the
// remaining max box as "Spells Prepared" (prepared entries) or "Spells Known"
// (spontaneous). Pure DOM in renderCharacterSheetPF2e — nothing is persisted, so
// unmarking Essence makes the native counter return on the next render, no cleanup.
// =============================================================================

let _spellCounterHookId = null;

registerTweak({
	id: "essenceSpellCounters",
	name: "Essence: Relabel Spell Counters",
	hint: "On Essence-marked spellcasting entries, repurposes each per-rank header counter as \"Spells Known\" / \"Spells Prepared\" (showing the max only), since essence spells aren't expended per rank.",
	default: true,
	onEnable() {
		if (!_spellCounterHookId) {
			_spellCounterHookId = Hooks.on("renderCharacterSheetPF2e", _onRenderSpellCounters);
		}
	},
	onDisable() {
		if (_spellCounterHookId) {
			Hooks.off("renderCharacterSheetPF2e", _spellCounterHookId);
			_spellCounterHookId = null;
		}
	}
});

// For each Essence entry, strip the value/charges side of every rank header counter
// and prepend a label to the surviving max box. Idempotent within a render (guards on
// the injected label) and re-applied each render since PF2e rebuilds the header fresh.
function _onRenderSpellCounters(sheet, html) {
	const actor = sheet?.actor;
	if (!actor) return;
	const entries = _essenceEntries(actor);
	if (!entries.length) return;

	const root = sheet.element?.[0] ?? sheet.element ?? (html instanceof HTMLElement ? html : html?.[0]);
	if (!root?.querySelectorAll) return;

	for (const entry of entries) {
		const text = entry.isPrepared ? "Spells Prepared" : "Spells Known";
		for (const row of root.querySelectorAll(`li.header-row[data-item-id="${entry.id}"]`)) {
			// Cantrips are at-will, not essence-pool-governed; leave their ∞ / native
			// count alone rather than relabeling it as a known/prepared slot count.
			if (row.dataset.groupId === "cantrips") continue;
			const itemName = row.querySelector(".item-name");
			if (!itemName || itemName.querySelector(".sky-spell-count-label")) continue;
			// Only relabel a row that actually has a max box to label; otherwise leave
			// the header untouched instead of appending a dangling label.
			const maxBox = itemName.querySelector(".spell-max-input, .spell-max");
			if (!maxBox) continue;
			itemName
				.querySelectorAll('.spell-slots-input, .slash, .flex0, .spell-slots.infinity, a[data-action="reset-spell-slots"]')
				.forEach(el => el.remove());
			const tag = document.createElement("span");
			tag.className = "sky-spell-count-label";
			tag.textContent = text;
			itemName.insertBefore(tag, maxBox);
		}
	}
}

// =============================================================================
// Tweak: Refocus button
//
// Adds a "Refocus" button to the top of every character's spellcasting tab that,
// on confirmation, runs a house-rule refresh against that sheet's actor:
//   - refills the focus pool to its cap (house rule: full pool, not RAW +1),
//   - tops up the "life-essence" special resource by 1/3 of its max,
//   - fully clears the "Effect: Maintaining Incantations" effect (any stack count),
//   - posts a "<name> refocuses." chat message.
// This is the sheet-button equivalent of the standalone refocus macro.
// =============================================================================

let _refocusSheetHookId = null;
let _refocusHotbarHookId = null;

// Drag tag handed to the hotbar; the hotbarDrop hook recognises it and creates the
// Refocus macro in the dropped slot.
const REFOCUS_DRAG_TYPE = "sky-refocus-macro";
const REFOCUS_MACRO_NAME = "Refocus";
const REFOCUS_MACRO_IMG = "icons/magic/light/explosion-star-glow-blue.webp";

// Standalone hotbar-macro body. Unlike the sheet button (which knows its actor), a
// hotbar macro has no sheet context, so it acts on the selected token(s). Kept in
// sync with _doRefocus by hand — same three steps plus a chat line.
const REFOCUS_MACRO_SOURCE = `const _seen = new Set();
const actors = game.user.getActiveTokens().flatMap((t) => t.actor ?? []).filter((a) => a && !_seen.has(a.id) && _seen.add(a.id));
if (actors.length === 0) {
    return ui.notifications.error("PF2E.ErrorMessage.NoTokenSelected", { localize: true });
}

const MAINTAINING_INCANTATIONS_UUID = "${MAINTAINING_INCANTATIONS_UUID}";
const MAINTAINING_INCANTATIONS_NAME = "${MAINTAINING_INCANTATIONS_NAME}";

const names = actors.map((a) => foundry.utils.escapeHTML?.(a.name) ?? a.name);
const who = names.length === 1 ? \`<strong>\${names[0]}</strong>\` : \`<strong>\${names.length}</strong> selected tokens (\${names.join(", ")})\`;
const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Refocus" },
    content: \`<p>Refresh \${who}?</p><p>This refills focus to full, restores 1/3 of the Life Essence reservoir, and clears the Maintaining Incantations effect.</p>\`,
});
if (!confirmed) return;

for (const actor of actors) {
    // Refill all focus points to cap (house rule).
    const focus = actor.system.resources?.focus;
    if (focus && focus.cap > 0 && focus.value < focus.cap) {
        await actor.update({ "system.resources.focus.value": focus.cap });
    }

    // Life Essence reservoir refill (1/3 of max).
    const resource = actor.getResource?.("life-essence");
    if (resource) {
        const { value, max } = resource;
        const newValue = Math.min(value + Math.floor(max / 3), max);
        if (newValue > value) await actor.updateResource("life-essence", newValue);
    }

    // Remove Effect: Maintaining Incantations (full clear, any stack count).
    const incantationEffects = actor.itemTypes.effect.filter(
        (e) => e.sourceId === MAINTAINING_INCANTATIONS_UUID || e.name === MAINTAINING_INCANTATIONS_NAME
    );
    if (incantationEffects.length > 0) {
        await actor.deleteEmbeddedDocuments("Item", incantationEffects.map((e) => e.id));
    }

    ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: \`\${actor.name} refocuses.\`,
    });
}`;

registerTweak({
	id: "refocusButton",
	name: "Refocus Button",
	hint: "Adds a Refocus button to the top of the spellcasting tab. On confirm it refills the focus pool to full (house rule), restores 1/3 of the Life Essence reservoir, clears the Maintaining Incantations effect, and posts a chat message. Drag the button to the hotbar to create a Refocus macro.",
	default: true,
	onEnable() {
		if (!_refocusSheetHookId) {
			_refocusSheetHookId = Hooks.on("renderCharacterSheetPF2e", _onRenderRefocusButton);
		}
		if (!_refocusHotbarHookId) {
			_refocusHotbarHookId = Hooks.on("hotbarDrop", _onRefocusHotbarDrop);
		}
	},
	onDisable() {
		if (_refocusSheetHookId) {
			Hooks.off("renderCharacterSheetPF2e", _refocusSheetHookId);
			_refocusSheetHookId = null;
		}
		if (_refocusHotbarHookId) {
			Hooks.off("hotbarDrop", _refocusHotbarHookId);
			_refocusHotbarHookId = null;
		}
	}
});

// When the Refocus button is dragged onto the hotbar, create (or reuse) the Refocus
// macro and assign it to the dropped slot. hotbarDrop is synchronous and Foundry
// won't await it, so the async work runs fire-and-forget and we return false to
// suppress Foundry's own drop handling.
function _onRefocusHotbarDrop(bar, data, slot) {
	if (data?.type !== REFOCUS_DRAG_TYPE) return;
	(async () => {
		let macro = game.macros.find(m => m.name === REFOCUS_MACRO_NAME && m.command === REFOCUS_MACRO_SOURCE);
		if (!macro) {
			macro = await Macro.create({
				name: REFOCUS_MACRO_NAME,
				type: "script",
				img: REFOCUS_MACRO_IMG,
				command: REFOCUS_MACRO_SOURCE
			});
		}
		await game.user.assignHotbarMacro(macro, slot);
	})();
	return false;
}

// Inject the Refocus button at the top of the spellcasting tab's spell-collections,
// alongside the same injection point Incantation Mode uses. Shown on all character
// sheets; only the sheet's owner can act on it.
function _onRenderRefocusButton(sheet, html) {
	const actor = sheet?.actor;
	if (!actor?.isOwner) return;

	const root = sheet.element?.[0] ?? sheet.element ?? (html instanceof HTMLElement ? html : html?.[0]);
	const collections = root?.querySelector?.(".tab.spellcasting .spell-collections");
	if (!collections || collections.querySelector(".sky-refocus-button")) return;

	const button = document.createElement("button");
	button.type = "button";
	button.className = "sky-refocus-button";
	button.dataset.tooltip = "Refocus: refill focus to full, restore 1/3 Life Essence, and clear Maintaining Incantations.<br><em>Tip: drag this to your hotbar to make a Refocus macro.</em>";
	button.innerHTML = `<i class="fa-solid fa-fw fa-spa"></i> Refocus`;

	// Allow dragging the button to the hotbar; _onRefocusHotbarDrop turns it into a macro.
	button.draggable = true;
	button.addEventListener("dragstart", (ev) => {
		ev.dataTransfer?.setData("text/plain", JSON.stringify({ type: REFOCUS_DRAG_TYPE }));
	});

	button.addEventListener("click", async () => {
		button.disabled = true;
		try {
			const confirmed = await foundry.applications.api.DialogV2.confirm({
				window: { title: "Refocus" },
				content: `<p>Refresh <strong>${foundry.utils.escapeHTML?.(actor.name) ?? actor.name}</strong>?</p>`
					+ `<p>This refills focus to full, restores 1/3 of the Life Essence reservoir, and clears the Maintaining Incantations effect.</p>`
			});
			if (confirmed) await _doRefocus(actor);
		}
		finally {
			button.disabled = false;
		}
	});
	// Append within the shared header so the button sits to the right of the toggle.
	_spellTabHeader(collections).append(button);
}

// Run the refocus refresh against a single actor (button + macro share this logic).
async function _doRefocus(actor) {
	// Refill all focus points to cap (house rule).
	const focus = actor.system.resources?.focus;
	if (focus && focus.cap > 0 && focus.value < focus.cap) {
		await actor.update({ "system.resources.focus.value": focus.cap });
	}

	// Life Essence reservoir refill (1/3 of max).
	const resource = actor.getResource?.("life-essence");
	if (resource) {
		const { value, max } = resource;
		const newValue = Math.min(value + Math.floor(max / 3), max);
		if (newValue > value) await actor.updateResource("life-essence", newValue);
	}

	// Remove Effect: Maintaining Incantations (full clear, any stack count).
	const incantationEffects = actor.itemTypes.effect.filter(
		e => e.sourceId === MAINTAINING_INCANTATIONS_UUID || e.name === MAINTAINING_INCANTATIONS_NAME
	);
	if (incantationEffects.length > 0) {
		await actor.deleteEmbeddedDocuments("Item", incantationEffects.map(e => e.id));
	}

	ChatMessage.create({
		speaker: ChatMessage.getSpeaker({ actor }),
		content: `${actor.name} refocuses.`
	});
}

// =============================================================================
// Tweak: Chat performance fix  (merged from the standalone chat-perf-fix module)
//
// Clearing/deleting a large chat log froze the client for tens of seconds: core's
// #deleteMessage calls getBoundingClientRect() per removed message, forcing a
// synchronous reflow each time — O(n^2) over a big log. Fix: hide the visible chat
// log (display:none) during a burst of deletions so those per-message reflows are
// free, then restore once deletions settle. Covers the GM (who calls
// deleteDocuments) via a wrap, and players (socket-driven) via the delete hook.
// Companion content-visibility CSS lives in tweaks.css.
// =============================================================================

const CPF_BURST_THRESHOLD = 3; // hide once this many deletions land in a burst
const CPF_SETTLE_MS = 300; // restore this long after deletions stop
const CPF_FALLBACK_MS = 2000; // safety restore if hooks somehow never settle

let _cpfHiddenLog = null;
let _cpfRestoreTimer = null;
let _cpfBurstCount = 0;
let _cpfDeleteHookId = null;
let _cpfOriginalDelete = null;

function _cpfVisibleChatLog() {
	const logs = [...document.querySelectorAll("ol.chat-log")];
	return logs.find(el => el.offsetParent !== null) ?? null;
}

function _cpfHideLog() {
	if (_cpfHiddenLog) return;
	const log = _cpfVisibleChatLog();
	if (log) {
		log.style.display = "none";
		_cpfHiddenLog = log;
	}
}

function _cpfScheduleSettle(delay) {
	clearTimeout(_cpfRestoreTimer);
	_cpfRestoreTimer = setTimeout(() => {
		if (_cpfHiddenLog) {
			_cpfHiddenLog.style.display = "";
			_cpfHiddenLog = null;
		}
		_cpfBurstCount = 0;
	}, delay);
}

function _cpfOnDeleteMessage() {
	_cpfBurstCount += 1;
	if (_cpfBurstCount >= CPF_BURST_THRESHOLD) _cpfHideLog();
	_cpfScheduleSettle(CPF_SETTLE_MS);
}

registerTweak({
	id: "chatPerfFix",
	name: "Chat Performance Fix",
	hint: "Stops the multi-second freeze when clearing or bulk-deleting a large chat log by hiding the log during the deletion burst (one reflow instead of hundreds).",
	default: true,
	onEnable() {
		if (!_cpfDeleteHookId) {
			_cpfDeleteHookId = Hooks.on("deleteChatMessage", _cpfOnDeleteMessage);
		}
		// GM-side proactive hide: wrap deleteDocuments so we can hide before any DOM
		// work happens. Store the true original so disable can restore it cleanly.
		const DocClass = CONFIG.ChatMessage.documentClass;
		if (!_cpfOriginalDelete) {
			_cpfOriginalDelete = DocClass.deleteDocuments;
			DocClass.deleteDocuments = async function (ids = [], operation = {}) {
				const isBulk = operation?.deleteAll === true
					|| (Array.isArray(ids) && ids.length >= CPF_BURST_THRESHOLD);
				if (isBulk) _cpfHideLog();
				try {
					return await _cpfOriginalDelete.call(this, ids, operation);
				}
				finally {
					if (_cpfHiddenLog) _cpfScheduleSettle(CPF_FALLBACK_MS);
				}
			};
		}
	},
	onDisable() {
		if (_cpfDeleteHookId) {
			Hooks.off("deleteChatMessage", _cpfDeleteHookId);
			_cpfDeleteHookId = null;
		}
		const DocClass = CONFIG.ChatMessage.documentClass;
		if (_cpfOriginalDelete) {
			DocClass.deleteDocuments = _cpfOriginalDelete;
			_cpfOriginalDelete = null;
		}
		clearTimeout(_cpfRestoreTimer);
		if (_cpfHiddenLog) {
			_cpfHiddenLog.style.display = "";
			_cpfHiddenLog = null;
		}
		_cpfBurstCount = 0;
	}
});

// =============================================================================
// Tweak: Target Conditions  (merged from the standalone pf2e-target-conditions module)
//
// Reads pf2e-toolbelt's per-target save outcomes off a chat card and injects
// per-target buttons to apply the spell/action's success/failure conditions
// (parsed from the item description). GM-only; soft-depends on pf2e-toolbelt (no-ops
// when it isn't active). Scoped CSS (.pf2e-tc-*) lives in tweaks.css.
// =============================================================================

const TC_TOOLBELT_ID = "pf2e-toolbelt";

const TC_OUTCOME_LABELS = {
	criticalSuccess: "Critical Success",
	success: "Success",
	failure: "Failure",
	criticalFailure: "Critical Failure"
};

const TC_OUTCOME_CSS = {
	criticalSuccess: "critical-success",
	success: "success",
	failure: "failure",
	criticalFailure: "critical-failure"
};

let _tcRenderHookId = null;

function _tcIsApplicableUuid(uuid) {
	return uuid.startsWith("Compendium.");
}

registerTweak({
	id: "targetConditions",
	name: "Target Conditions",
	hint: "On chat cards with pf2e-toolbelt save results, adds per-target buttons to apply the spell/action's success/failure conditions. GM-only; requires the pf2e-toolbelt module.",
	default: true,
	onEnable() {
		if (!_tcRenderHookId) {
			_tcRenderHookId = Hooks.on("renderChatMessageHTML", _tcOnRenderChatCard);
		}
	},
	onDisable() {
		if (_tcRenderHookId) {
			Hooks.off("renderChatMessageHTML", _tcRenderHookId);
			_tcRenderHookId = null;
		}
	}
});

async function _tcOnRenderChatCard(message, html) {
	// Only GMs need the condition apply buttons.
	if (!game.user.isGM) return;
	// Soft dependency: do nothing if Toolbelt isn't installed/active.
	if (!game.modules.get(TC_TOOLBELT_ID)?.active) return;

	// Must have a pf2e-toolbelt targetHelper flag.
	const flagData = message.getFlag(TC_TOOLBELT_ID, "targetHelper");
	if (!flagData) return;

	// Primary save variant (spells without variants use key 'null').
	const saveVariants = flagData.saveVariants ?? {};
	const saveVariant = saveVariants.null ?? Object.values(saveVariants)[0];
	if (!saveVariant) return;

	// Only proceed if at least one save has been rolled.
	const saves = saveVariant.saves ?? {};
	if (Object.keys(saves).length === 0) return;

	// Resolve the spell/action item — prefer the flag's stored UUID, else message.item.
	const spell = await _tcResolveItem(message, flagData);
	if (!spell?.system?.description?.value) return;

	// Parse conditions per outcome from the item description.
	const conditionsByOutcome = await _tcParseConditions(spell.system.description.value);
	if (!conditionsByOutcome || Object.keys(conditionsByOutcome).length === 0) return;

	// Resolve token documents from stored UUIDs.
	const tokens = (flagData.targets ?? [])
		.map(uuid => fromUuidSync(uuid, { strict: false }))
		.filter(Boolean);
	if (!tokens.length) return;

	const panel = _tcBuildPanel(tokens, saves, conditionsByOutcome);
	if (!panel) return;

	// Defer insertion until after Toolbelt's async template renders resolve, so we
	// land after their target rows rather than before them.
	setTimeout(() => {
		const toolbeltRows = html.querySelector(".pf2e-toolbelt-target-targetRows");
		if (toolbeltRows) toolbeltRows.after(panel);
		else html.querySelector(".message-content")?.append(panel);
	}, 0);
}

async function _tcResolveItem(message, flagData) {
	if (flagData.item) {
		try {
			const item = await fromUuid(flagData.item);
			if (item) return item;
		}
		catch { /* fall through */ }
	}
	return message.item ?? null;
}

async function _tcParseConditions(descriptionHtml) {
	const enriched = await TextEditor.enrichHTML(descriptionHtml);
	const doc = new DOMParser().parseFromString(enriched, "text/html");

	const OUTCOME_MAP = {
		"Critical Success": "criticalSuccess",
		Success: "success",
		Failure: "failure",
		"Critical Failure": "criticalFailure"
	};

	const result = {};

	for (const para of doc.querySelectorAll("p, li")) {
		let outcomeKey = null;
		for (const strong of para.querySelectorAll("strong")) {
			const text = strong.textContent.trim();
			if (OUTCOME_MAP[text]) {
				outcomeKey = text;
				break;
			}
		}
		if (!outcomeKey) continue;

		const outcomeValue = OUTCOME_MAP[outcomeKey];
		const conditions = [];
		for (const link of para.querySelectorAll("a[data-uuid]")) {
			const uuid = link.dataset.uuid;
			if (!uuid || !_tcIsApplicableUuid(uuid)) continue;
			conditions.push({ uuid, name: link.textContent.trim() });
		}

		if (conditions.length) {
			if (result[outcomeValue]) result[outcomeValue].push(...conditions);
			else result[outcomeValue] = conditions;
		}
	}

	return result;
}

function _tcBuildPanel(tokens, saves, conditionsByOutcome) {
	const rows = [];
	for (const token of tokens) {
		const save = saves[token.id];
		if (!save?.success) continue;
		const conditions = conditionsByOutcome[save.success];
		if (!conditions?.length) continue;
		rows.push({ token, outcome: save.success, conditions });
	}
	if (!rows.length) return null;

	const panel = document.createElement("div");
	panel.classList.add("pf2e-tc-panel");

	for (const { token, outcome, conditions } of rows) {
		const sep = document.createElement("hr");
		sep.classList.add("pf2e-tc-sep");
		panel.append(sep);

		const row = document.createElement("div");
		row.classList.add("pf2e-tc-row");

		const nameSpan = document.createElement("span");
		nameSpan.classList.add("pf2e-tc-name");
		nameSpan.textContent = token.name;

		const outcomeSpan = document.createElement("span");
		outcomeSpan.classList.add("pf2e-tc-outcome", TC_OUTCOME_CSS[outcome]);
		outcomeSpan.textContent = TC_OUTCOME_LABELS[outcome];

		const btnsDiv = document.createElement("div");
		btnsDiv.classList.add("pf2e-tc-buttons");

		for (const condition of conditions) {
			const btn = document.createElement("button");
			btn.classList.add("pf2e-tc-apply-btn");
			btn.textContent = condition.name;
			btn.title = `Apply ${condition.name} to ${token.name}`;
			btn.dataset.uuid = condition.uuid;
			btn.addEventListener("click", async (e) => {
				e.stopPropagation();
				await _tcApplyToToken(condition, token, btn);
			});
			btnsDiv.append(btn);
		}

		row.append(nameSpan, outcomeSpan, btnsDiv);
		panel.append(row);
	}

	return panel;
}

async function _tcApplyToToken(condition, token, btn) {
	if (!token.actor) {
		ui.notifications.warn(`No actor found for ${token.name}.`);
		return;
	}

	try {
		btn.disabled = true;

		const item = await fromUuid(condition.uuid);
		if (!item) {
			ui.notifications.warn(`Could not find item: ${condition.uuid}`);
			btn.disabled = false;
			return;
		}

		const slug = item.slug ?? item.system?.slug;
		if (!slug) {
			ui.notifications.warn(`No condition slug for: ${condition.name}`);
			btn.disabled = false;
			return;
		}

		// Parse trailing number from display name, e.g. "Frightened 2" → value 2.
		const valueMatch = condition.name.match(/\s(\d+)$/);
		const value = valueMatch ? parseInt(valueMatch[1]) : undefined;

		// Use the system condition API rather than cloning the item: increaseCondition
		// takes the MAX of the existing and applied value (two "Frightened 1"s stay
		// Frightened 1 — no summing) and never stacks a duplicate condition document.
		await token.actor.increaseCondition(slug, value !== undefined ? { value } : undefined);

		btn.classList.add("applied");
		btn.innerHTML = `<i class="fa-solid fa-check"></i> ${condition.name}`;
	}
	catch (err) {
		console.error(`${MODULE_ID} | targetConditions: error applying condition to ${token.name}:`, err);
		ui.notifications.error(`Failed to apply ${condition.name}: ${err.message}`);
		btn.disabled = false;
	}
}

// =============================================================================
// Tweak: Life Essence max-rank auto-update
//
// Magic+ computes flags.pf2e.maxhealingRank (the Life Essence Reservoir's max =
// maxhealingRank * healerAdjustment) from the highest-rank non-cantrip healing/harm
// spell in your essence entries — but ONLY on `updateItem` (when you edit a spell or
// entry). It never refreshes on a fresh load, a level-up, or just opening the sheet,
// so the flag goes stale and you end up editing it by hand. This tweak re-runs Magic+'s
// exact computation as a `renderCharacterSheetPF2e` backstop: idempotent (writes only
// when the computed rank differs from the stored flag), owner-gated, so it self-corrects
// without manual edits and without a render loop.
// =============================================================================

let _maxRankSheetHookId = null;

// Returns the computed max healing rank, or null when the actor isn't an essence caster
// (so the caller can skip). Mirrors Magic+'s updateLifeEssence updateItem logic.
async function _computeMaxHealingRank(actor) {
	if (!actor?.spellcasting) return null;
	const entries = actor.spellcasting.regular.filter(x => x?.flags?.[MAGICPLUS_ID]?.essence);
	if (!entries.length) return null;

	let rank = 0;
	for (const entry of entries) {
		const sheetData = await entry.getSheetData();
		const slotSpells = (sheetData.groups ?? [])
			.flatMap(g => g.active)
			.filter(x => x && !x.spell?.traits?.has?.("cantrip"));
		for (const meta of slotSpells) {
			const isHealing = meta?.spell?.traits?.has?.("healing");
			const isSpecific = meta?.spell?.slug === "harm";
			if (isHealing || isSpecific) rank = Math.max(rank, meta?.castRank || meta?.spell?.rank || 0);
		}
	}
	return rank;
}

async function _onRenderMaxHealingRank(sheet) {
	const actor = sheet?.actor;
	// Only an owner can write the flag; non-owner renders no-op.
	if (!actor?.isOwner) return;

	const rank = await _computeMaxHealingRank(actor);
	if (rank === null) return; // not an essence caster

	const current = actor.flags?.pf2e?.maxhealingRank ?? 0;
	if (rank === current) return; // idempotent — the re-render this triggers will no-op

	await actor.update({ "flags.pf2e.maxhealingRank": rank });
}

registerTweak({
	id: "lifeEssenceMaxRank",
	name: "Life Essence Max Rank Auto-Update",
	hint: "Keeps flags.pf2e.maxhealingRank (the Life Essence Reservoir's max) current by recomputing it from your highest healing/harm spell whenever the sheet renders — Magic+ only refreshes it when you edit your spell list, so it otherwise goes stale.",
	default: true,
	onEnable() {
		if (!_maxRankSheetHookId) {
			_maxRankSheetHookId = Hooks.on("renderCharacterSheetPF2e", _onRenderMaxHealingRank);
		}
	},
	onDisable() {
		if (_maxRankSheetHookId) {
			Hooks.off("renderCharacterSheetPF2e", _maxRankSheetHookId);
			_maxRankSheetHookId = null;
		}
	}
});

// =============================================================================
// Tweak: Reservoir remote sync
//
// Magic+ deducts/refunds the healer's `life-essence` reservoir in pre-create/-update
// chat hooks that run on the APPLYING client. When a player applies (or reverts) healing
// from an essence caster they don't OWN, that actor.update is permission-rejected — the
// reservoir never moves. Fix: the active GM (who owns every actor) replays the same write
// on the post hooks, but ONLY when the triggering user doesn't own the healer (when they
// do, Magic+ already handled it on their client — so we skip to avoid double-counting).
// Mirrors Magic+'s exact math, so owner/non-owner behave identically. Pool deduction/refund
// only — the cosmetic "depleted" warning is left to Magic+'s own client-side append.
// =============================================================================

let _reservoirCreateHookId = null;
let _reservoirUpdateHookId = null;

function _reservoirHealer(pf2e) {
	if (!pf2e?.context?.domains?.includes("healing-received")) return null;
	const { appliedDamage, context, origin } = pf2e;
	if (!appliedDamage || !context || !origin) return null;
	const actor = fromUuidSync(origin.actor);
	if (!actor?.spellcasting) return null;
	if (!actor.getResource?.("life-essence")) return null;
	return actor;
}

// Deduction: GM replays the life-essence spend for a cross-owner heal.
async function _onReservoirHealApplied(message) {
	// Cheapest guard first — every non-active-GM client exits here.
	if (game.users.activeGM !== game.user) return;

	const actor = _reservoirHealer(message.flags?.pf2e);
	if (!actor) return;
	if (!message.item?.traits?.has?.("healing")) return;

	// Skip if the message author owns the healer — Magic+ already deducted on their client.
	const author = message.author;
	if (author && actor.testUserPermission(author, "OWNER")) return;

	const resource = actor.getResource("life-essence");
	const appliedHealing = message.flags.pf2e.appliedDamage.updates
		.find(x => x.path === "system.attributes.hp.value")?.value || 0;
	if (!appliedHealing) return;

	await actor.updateResource("life-essence", resource.value + appliedHealing, { render: true });
}

// Refund: GM replays Magic+'s revert refund (diff-based) for a cross-owner revert.
async function _onReservoirHealReverted(message, changes, options, userId) {
	if (game.users.activeGM !== game.user) return;
	if (!changes?.flags?.pf2e?.appliedDamage?.isReverted) return;

	const actor = _reservoirHealer(message.flags?.pf2e);
	if (!actor) return;

	// Skip if the reverting user owns the healer — Magic+ already refunded on their client.
	const user = game.users.get(userId);
	if (user && actor.testUserPermission(user, "OWNER")) return;
	if (!message.item?.traits?.has?.("healing")) return;

	// Magic+ only stores `diff` when the pool overflowed (depletion) — in that case it
	// restores the pre-heal value. For a normal heal it stores nothing and refunds
	// nothing, so we fall back to refunding exactly what we deducted (-appliedHealing).
	const diff = message.flags?.[MAGICPLUS_ID]?.diff;
	const appliedHealing = message.flags?.pf2e?.appliedDamage?.updates
		?.find(x => x.path === "system.attributes.hp.value")?.value || 0;
	const cashBack = (typeof diff === "number") ? diff : -appliedHealing;
	if (!cashBack) return;

	const resource = actor.getResource("life-essence");
	await actor.updateResource("life-essence", resource.value + cashBack, { render: true });
}

registerTweak({
	id: "reservoirRemoteSync",
	name: "Reservoir Remote Sync",
	hint: "Fixes Magic+'s Life Essence Reservoir not deducting/refunding when a player applies or reverts healing from an essence caster they don't own (a permissions gap). The active GM replays the reservoir change. Requires a GM online.",
	default: true,
	onEnable() {
		if (!_reservoirCreateHookId) {
			_reservoirCreateHookId = Hooks.on("createChatMessage", _onReservoirHealApplied);
		}
		if (!_reservoirUpdateHookId) {
			_reservoirUpdateHookId = Hooks.on("updateChatMessage", _onReservoirHealReverted);
		}
	},
	onDisable() {
		if (_reservoirCreateHookId) {
			Hooks.off("createChatMessage", _reservoirCreateHookId);
			_reservoirCreateHookId = null;
		}
		if (_reservoirUpdateHookId) {
			Hooks.off("updateChatMessage", _reservoirUpdateHookId);
			_reservoirUpdateHookId = null;
		}
	}
});

// =============================================================================
// Core setup
// =============================================================================

Hooks.once("init", () => {
	for (const tweak of TWEAKS) {
		game.settings.register(MODULE_ID, tweak.id, {
			name: tweak.name,
			hint: tweak.hint,
			scope: "client",
			config: false,
			type: Boolean,
			default: tweak.default ?? true
		});
	}

	game.settings.registerMenu(MODULE_ID, "tweaksMenu", {
		name: "Configure Tweaks",
		label: "Open Tweaks",
		hint: "Enable or disable individual tweaks.",
		icon: "fa-solid fa-sliders",
		type: TweaksConfig,
		restricted: false
	});
});

Hooks.once("ready", () => {
	for (const tweak of TWEAKS) {
		if (game.settings.get(MODULE_ID, tweak.id)) {
			tweak.onEnable?.();
		}
	}
	const mod = game.modules.get(MODULE_ID);
	if (mod) mod.api = Object.assign(mod.api ?? {}, { inspectLeak, leakDebug, cleanupLeakRules });
});

// ----- Settings UI -----

class TweaksConfig extends FormApplication {
	static get defaultOptions() {
		return foundry.utils.mergeObject(super.defaultOptions, {
			id: "sky-2e-tweaks-config",
			title: "Sky's 2e Tweaks",
			template: `modules/${MODULE_ID}/templates/settings.hbs`,
			width: 500,
			closeOnSubmit: true
		});
	}

	getData() {
		const tweaks = TWEAKS.map(t => ({
			id: t.id,
			name: t.name,
			hint: t.hint,
			enabled: game.settings.get(MODULE_ID, t.id)
		}));
		return { tweaks };
	}

	async _updateObject(event, formData) {
		for (const tweak of TWEAKS) {
			const key = `tweaks.${tweak.id}`;
			const newVal = !!formData[key];
			const oldVal = game.settings.get(MODULE_ID, tweak.id);
			await game.settings.set(MODULE_ID, tweak.id, newVal);
			if (newVal && !oldVal) tweak.onEnable?.();
			if (!newVal && oldVal) tweak.onDisable?.();
		}
		ui.notifications.info("Tweaks updated. Some changes may require a refresh.");
	}
}
