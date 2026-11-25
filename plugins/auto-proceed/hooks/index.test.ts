import { expect, test } from 'claude-code/testing'

import { shouldProceed } from './index'

const fire = (text: string, extra: { askedUser?: boolean; chain?: number } = {}) => shouldProceed({ text, askedUser: false, chain: 0, ...extra }).fire
const assert = { strictEqual: (a: unknown, b: unknown) => expect(a).toBe(b) }

test('fires: plain "Shall I continue?"', () => assert.strictEqual(fire('Step 2 done.\n\nShall I continue?'), true));
test('fires: "Want me to proceed with step 3?"', () => assert.strictEqual(fire('Tests green. Want me to proceed with step 3?'), true));
test('fires: "Ready to continue?"', () => assert.strictEqual(fire('Refactor complete.\nReady to continue?'), true));
test('fires: "reply **go** to start"', () => assert.strictEqual(fire('Plan written. Reply **go** to start.'), true));

test('no fire: 👉 You step only the user can do (Shift+Tab plan mode)', () => {
  assert.strictEqual(fire('🟢 PRD saved.\n\n👉 **You:** press **Shift+Tab** to enter plan mode, then type: `Plan tg from PRD.md`. Plan mode is a setting only you can switch on.\n\n[11:59 AM]'), false);
});
test('no fire: 👉 You key press (Esc) then type', () => {
  assert.strictEqual(fire('🟢 Saved.\n\n👉 **You:** press Esc twice to rewind, then type `go`.'), false);
});
test('no fire: 👉 You opens a maintenance window (the user-only switch)', () => {
  assert.strictEqual(fire('🟢 Five fixes live.\n\n👉 **You:** run the `touch` line above to open the maintenance window, then type "maint on".'), false);
  assert.strictEqual(fire('🟢 Done.\n\n👉 **You:** run `touch ~/.claude/x.maint`, then reply "maint on", and I\'ll apply #5.'), false);
});
test('fires: 👉 You "type go and I\'ll run the tests" still a stall', () => {
  assert.strictEqual(fire('🟢 Ready.\n\n👉 **You:** type **go** and I\'ll run the tests.'), true);
});

test('no fire: numbered options list', () => {
  assert.strictEqual(fire('Two ways:\n1. Patch the helper\n2. Rewrite the module\n\nShall I continue?'), false);
});
test('no fire: lettered / bold options list', () => {
  assert.strictEqual(fire('- **1** fast path\n- **2** safe path\nShall I proceed?'), false);
});
test('no fire: contains 🔴', () => assert.strictEqual(fire('🔴 touches billing.\nShall I continue?'), false));
test('no fire: contains "merge"', () => assert.strictEqual(fire('Next is the merge to main. Shall I continue?'), false));
test('no fire: 🟡 need-you ask with ← pick', () => assert.strictEqual(fire('🟡 Topic 4 of 6\n1. A ←\n2. B\nReply with a number.'), false));
test('no fire: header then 🟡 ask with ← pick', () => assert.strictEqual(fire('**Last time:** x\n**Now:** y\n\n🟡 Topic 1 of 9\n1. A ←\n2. B\nReply with a number.'), false));
test('no fire: 🟢 "Topic saved" then next question', () => assert.strictEqual(fire('🟢 Topic 1 saved: WhatsApp first.\n\n---\n\n**Topic 2 of 14**\n1. **Done in test mode.** ← recommended\n2. **Done after real code.**\n3. Other (type your own)\n\nReply with a number.'), false));
test('no fire: 👉 You asks reply A, B or C', () => assert.strictEqual(fire('🟢 Three ways.\n- **A.** Add it\n- **B.** Rewrite\n- **C.** Skip\n👉 **You:** reply A, B or C.'), false));
test('no fire: Pending blocked on your choice', () => assert.strictEqual(fire('Fixes 1 and 3 ready.\n1. Fix it ←\n2. Leave it\n⏳ Pending:\n1. Codex findings. Blocked on: your choice above.'), false));
test('fires: Next (no reply needed) with ← pick in Pending', () => assert.strictEqual(fire('🟢 Worker building.\n👉 Next (no reply needed): I test the build.\n⏳ **Pending:**\n1. Link: waits on pick, **Tailscale ←** or Ports tab.\n2. Step 5.2: waits for go.'), true));
test('no fire: "Q3 …?" heading over ← menu', () => assert.strictEqual(fire('🟢 Set as your answer to Q2.\n\n**Q3: When does a server count as unused?**\n- **(a) After 15 idle minutes ← RECOMMENDED.**\n- (b) Right away.\n\nOr say "accept all recommended".'), false));
test('fires: rhetorical question above plain text then ← menu', () => assert.strictEqual(fire('🟢 Done.\nWhy did it fail?\nIt timed out.\n1. Rerun ←\n2. Skip'), true));
test('fires: 🟢 reply with 🟡 bullet and ← pick',() => assert.strictEqual(fire('🟢 Done.\n- 🟡 pending: X\n1. Run X ←\n2. Skip\nNext: run X'), true));
test('fires: 🟢 reply with ← pick and options',() => assert.strictEqual(fire('🟢 Done.\n1. Run X ←\n2. Skip\nNext: run X'), true));
test('no fire: askedUser=true', () => assert.strictEqual(fire('Shall I continue?', { askedUser: true }), false));
test('no fire: chain=3', () => assert.strictEqual(fire('Shall I continue?', { chain: 3 }), false));
test('no fire: no soft-continue phrase', () => assert.strictEqual(fire('All done.'), false));
test('fires: "say commit and I\'ll run safe-commit"', () => assert.strictEqual(fire("Tests green.\n👉 **You:** say `commit` and I'll run safe-commit."), true));
test('fires: "Reply archive to mark it reviewed"', () => assert.strictEqual(fire('Review done.\nReply archive to mark it reviewed.'), true));
test('fires: menu with ← pick', () => assert.strictEqual(fire('Pick:\n1. Fix and rerun ←\n2. Stop'), true));
test('no fire: menu with ← but risk word', () => assert.strictEqual(fire('Pick:\n1. merge now ←\n2. wait'), false));
test('no fire: menu without ← pick', () => assert.strictEqual(fire('Pick:\n1. Patch\n2. Rewrite'), false));
test('no fire: nothing-left Next line with a future say-offer', () => assert.strictEqual(fire("👉 Next (no reply needed): nothing until Saturday. When the notification comes, say \"review it\" and I'll read the results."), false));

// Real misfires from the settings-hook version, cut to the shape that matched. All four went through a
// pattern that fired on any 👉 You line holding "say", "reply" or "type".
test('no fire: 👉 You pointer to a command the user may type later', () => {
  assert.strictEqual(fire('🟢 Nine hook messages so far.\n\n👉 **You:** to finish the paused work, type `/pause resume abc123`.\n\n📚 **New word:** *hook*: a small script.'), false)
})
test('no fire: "reply" as a noun in a step on the user\'s phone', () => {
  assert.strictEqual(fire('🟢 Nothing to clean up.\n\n👉 **You:** keep working in the other workspace. It still needs your phone test reply.'), false)
})
test('no fire: 👉 You nothing needed, then a tip with a say-offer', () => {
  assert.strictEqual(fire('🟢 Answered.\n\n👉 **You:** nothing needed. One tip: when you see me repeat the same steps, say "script that" and I\'ll turn them into one command.'), false)
})
// Known cost of the strict pattern: this one was a useful nudge (Claude could run the check itself).
test('no fire: 👉 You step with "type" but no offer', () => {
  assert.strictEqual(fire('🟢 Done.\n\n👉 **You:** open a new pane and type `node --version`. It should print `v24`.'), false)
})
