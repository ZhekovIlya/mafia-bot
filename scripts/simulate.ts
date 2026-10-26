// End-to-end simulation of the Worker's Games Durable Object without Telegram.
// Telegram API calls are recorded by a mock fetch; Updates are fed through games.fetch().
// Run with: npm run simulate
import { Games } from '../worker/index';

type Call = { method: string; body: any; messageId?: number };
const calls: Call[] = [];
let messageSeq = 1000;

// Mock Telegram: record every call and answer like the real API would.
(globalThis as any).fetch = async (url: string, init: { body: string }) => {
    const method = String(url).split('/').pop() as string;
    const body = JSON.parse(init.body);
    const call: Call = { method, body };
    calls.push(call);
    const hasMessage = ['sendMessage', 'sendPhoto'].includes(method);
    if (hasMessage) call.messageId = ++messageSeq;
    const result = hasMessage ? { message_id: call.messageId, chat: { id: body.chat_id } } : true;
    return new Response(JSON.stringify({ ok: true, result }));
};

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`);
};

const firstLine = (c: Call) => String(c.body.text ?? c.body.caption ?? '').split('\n')[0].slice(0, 90);
const printCalls = (from: number) => {
    for (const c of calls.slice(from)) {
        if (c.method === 'answerCallbackQuery') continue;
        const chat = c.body.chat_id ?? (c.body.inline_message_id ? 'inline' : '-');
        console.log(`    ${c.method.padEnd(16)} ${String(chat).padStart(11)}  ${firstLine(c)}`);
    }
};
const textOf = (c: Call) => String(c.body.text ?? c.body.caption ?? '');
const buttons = (c: Call): { text: string; callback_data?: string }[] =>
    (c.body.reply_markup?.inline_keyboard ?? []).flat();
const last = (pred: (c: Call) => boolean, from = 0) => [...calls.slice(from)].reverse().find(pred);

type User = { id: number; first_name: string; last_name?: string; username?: string };
let updateSeq = 0;

const scenario = async (title: string, opts: { extraTest: number; winner: 'Civilians' | 'Mafia'; staleName?: boolean; redash?: boolean }) => {
    console.log(`\n=== ${title} ===`);
    const store = new Map<string, unknown>();
    const state = {
        storage: {
            get: async (k: string) => store.get(k),
            put: async (k: string, v: unknown) => { store.set(k, JSON.parse(JSON.stringify(v))); },
        },
    };
    const env = { BOT_TOKEN: 'FAKE', BOT_USERNAME: 'fakebot', WEBHOOK_SECRET: 's', ADMIN_IDS: '1001', GAMES: null };
    const games = new Games(state as any, env as any);
    const start = calls.length;
    const feed = async (update: object) => {
        const res = await games.fetch(new Request('https://x/webhook', {
            method: 'POST',
            body: JSON.stringify({ update_id: ++updateSeq, ...update }),
        }));
        if (res.status !== 200) throw new Error('webhook did not answer 200');
    };
    const host: User = { id: 1001, first_name: 'Host', last_name: 'Boss', username: 'hostuser' };
    const girl: User = { id: 2002, first_name: 'Bea', username: opts.staleName ? 'girl_old' : 'girl' };
    const say = (from: User, text: string) => feed({
        message: { message_id: ++updateSeq, from, chat: { id: from.id, type: 'private' }, text },
    });
    const tap = (from: User, data: string, messageId = 1) => feed({
        callback_query: { id: `cb${++updateSeq}`, from, data, message: { message_id: messageId, chat: { id: from.id, type: 'private' } } },
    });

    // Host creates the game.
    await say(host, '/creategame Sim night');
    const lobby = last(c => c.method === 'sendMessage' && c.body.text?.includes('Sim night'), start)!;
    const gameId = buttons(lobby)[0].callback_data!.split('_')[1];
    check('lobby host line shows Name (@username)', textOf(lobby).includes('Host: Host Boss (@hostuser)'), textOf(lobby));

    // Real player joins through the deep link.
    await say(girl, `/start in_${gameId}`);
    check('join confirmation sent to player', !!last(c => c.method === 'sendMessage' && c.body.chat_id === 2002 && textOf(c).includes('on the list'), start));
    check('owner DM uses Name (@username)', !!last(c => c.body.chat_id === 1001 && textOf(c).startsWith(`🙋 Bea (@${girl.username}) is in`), start));

    if (opts.staleName) {
        girl.username = 'girl'; // player renamed on Telegram, taps again
        await say(girl, `/joingame ${gameId}`);
        const l = last(c => c.method === 'editMessageText' && textOf(c).includes('Interested'), start)!;
        check('stale username refreshed in lobby', textOf(l).includes('Bea (@girl)') && !textOf(l).includes('girl_old'), textOf(l));
    }

    // Non-admins cannot use test mode and learn their id.
    await say(girl, '/addtest 2');
    check('non-admin gets id hint', !!last(c => c.body.chat_id === 2002 && textOf(c) === '❌ Test mode is for admins. Your Telegram id is 2002 — add it to ADMIN_IDS to enable.', start));

    // Host adds dummies.
    const afterJoin = calls.length;
    await say(host, `/addtest ${opts.extraTest}`);
    check('host told how many test players were added',
        !!last(c => c.body.chat_id === 1001 && textOf(c) === `🤖 Added ${opts.extraTest} test players (${opts.extraTest + 1} interested)`, afterJoin));
    const lobbyEdit = last(c => c.method === 'editMessageText' && textOf(c).includes('Interested'), afterJoin)!;
    check('lobby lists test players', textOf(lobbyEdit).includes('🤖 Test 1') && textOf(lobbyEdit).includes(`Test ${opts.extraTest}`), textOf(lobbyEdit));

    // The host sends /dashboard once; from then on everything happens on that one message.
    let dashCommands = 1;
    const afterAdd = calls.length;
    await say(host, '/dashboard');
    const panel = last(c => c.method === 'sendMessage' && textOf(c).startsWith('📋 Lobby'), afterAdd)!;
    let dashId = panel.messageId!;
    const editsOf = (id: number, from: number) =>
        calls.slice(from).filter(c => c.method === 'editMessageText' && c.body.chat_id === 1001 && c.body.message_id === id);
    const latestDash = (id: number, from: number) => editsOf(id, from).pop();
    const removeBtn = buttons(panel).find(b => b.callback_data?.startsWith('lkick_') && b.text.includes('Bea'));
    check('panel remove button shows Name (@username)', !!removeBtn && removeBtn.text.includes('(@girl)'), removeBtn?.text);
    const lockBtn = buttons(panel).find(b => b.callback_data?.startsWith('llock_'))!;

    // Lobby changes after the panel exists refresh the panel itself.
    let mark = calls.length;
    await say(host, '/addtest 1');
    check('panel refreshed in place when a test player is added', !!latestDash(dashId, mark) && textOf(latestDash(dashId, mark)!).includes(`${opts.extraTest + 2} interested`));
    mark = calls.length;
    await say(host, '/cleartest');
    check('panel refreshed in place by /cleartest', !!latestDash(dashId, mark));
    mark = calls.length;
    await say(host, `/addtest ${opts.extraTest}`);
    check('panel refreshed in place after re-adding test players', !!latestDash(dashId, mark));

    mark = calls.length;
    await tap(host, lockBtn.callback_data!, dashId);
    const confirm = latestDash(dashId, mark)!;
    check('lock confirm is the dashboard message edited in place', !!confirm && textOf(confirm).startsWith('🔒 Lock roster') && !calls.slice(mark).some(c => c.method === 'sendMessage'));
    const dealBtn = buttons(confirm).find(b => b.callback_data?.startsWith('ldeal_'))!;
    mark = calls.length;
    await tap(host, dealBtn.callback_data!, dashId);
    const dealt = latestDash(dashId, mark);
    check('ldeal turns the dashboard into the active dashboard', !!dealt && textOf(dealt).startsWith('📋 Game Dashboard') && buttons(dealt).some(b => b.callback_data?.startsWith('revealall_')), dealt && textOf(dealt));
    check('ldeal sends no "Roles assigned" message to the host', !calls.slice(mark).some(c => c.method === 'sendMessage' && c.body.chat_id === 1001));
    check('ldeal answers with a toast', !!last(c => c.method === 'answerCallbackQuery' && String(c.body.text ?? '').includes('Roles assigned'), mark));
    const lockedLobby = last(c => c.method === 'editMessageText' && textOf(c).includes('🔒 Roster locked —'), start);
    check('lobby edited with locked footer', !!lockedLobby && textOf(lockedLobby).includes(`${opts.extraTest + 1} playing`));
    check('dashboard reveal buttons show @username', buttons(dealt!).some(b => b.text.startsWith('🎭 Reveal') && b.text.includes('(@girl)')));

    if (opts.redash) {
        // Host re-sends /dashboard: old message deleted, new one is live, old buttons still work but get tidied.
        const oldId = dashId;
        mark = calls.length;
        await say(host, '/dashboard');
        dashCommands++;
        const fresh = last(c => c.method === 'sendMessage' && textOf(c).startsWith('📋 Game Dashboard'), mark)!;
        check('/dashboard again deletes the previous dashboard message', calls.slice(mark).some(c => c.method === 'deleteMessage' && c.body.message_id === oldId));
        dashId = fresh.messageId!;
        const oldReveal = buttons(dealt!).find(b => b.callback_data?.startsWith('reveal_'))!;
        mark = calls.length;
        await tap(host, oldReveal.callback_data!, oldId);
        check('stale dashboard button still acts, deletes itself and refreshes the current dashboard',
            calls.slice(mark).some(c => c.method === 'deleteMessage' && c.body.message_id === oldId) && !!latestDash(dashId, mark) && !latestDash(oldId, mark));
    } else {
        // Single reveal updates the dashboard and a mafia player's teammates get DMed.
        const dealtButtons = buttons(dealt!).filter(b => b.callback_data?.startsWith('reveal_'));
        mark = calls.length;
        await tap(host, dealtButtons[0].callback_data!, dashId);
        const afterOne = latestDash(dashId, mark);
        check('single reveal edits the dashboard (revealed marker)', !!afterOne && buttons(afterOne).some(b => b.text.startsWith('✅ 1.')) && textOf(afterOne).includes('Roles revealed: 1/'), afterOne && textOf(afterOne));
        const dmWho = calls.slice(mark).filter(c => c.method === 'sendMessage' && textOf(c).startsWith('🤝')).length;
        console.log(`  (single reveal of player 1 sent ${dmWho} teammate DM(s); test players are never messaged)`);
    }

    // Reveal all on the live dashboard, then read roles from it.
    const dashNow = latestDash(dashId, 0) ?? dealt!;
    const revealAll = buttons(dashNow).find(b => b.callback_data?.startsWith('revealall_'))!;
    mark = calls.length;
    await tap(host, revealAll.callback_data!, dashId);
    check('real player received a role photo', !!last(c => c.method === 'sendPhoto' && c.body.chat_id === 2002, start));
    const dash2 = latestDash(dashId, mark)!;
    check('reveal all edits the dashboard to the roster', !!dash2 && textOf(dash2).includes('Players with Roles'));
    const roster = textOf(dash2).split('\n').map(l => /^(\d+)\. (.+) - (.+?) [💚💀]$/u.exec(l)).filter(Boolean)
        .map(m => ({ order: Number(m![1]), label: m![2], role: m![3] }));
    check('dashboard roster lists every player with a role', roster.length === opts.extraTest + 1, textOf(dash2));
    check('dashboard roster shows @girl', roster.some(r => r.label === 'Bea (@girl)'));

    // Eliminate until the game ends, all on the same message.
    const isMafia = (role: string) => role === 'Mafia' || role === 'Mafia Don';
    const targets = roster.filter(r => (opts.winner === 'Civilians' ? isMafia(r.role) : !isMafia(r.role)));
    const beforeElim = calls.length;
    let cancelledOnce = false;
    for (const t of targets) {
        if (last(c => c.method === 'sendMessage' && textOf(c).startsWith('🏆'), beforeElim)) break;
        const current = latestDash(dashId, 0)!;
        const btn = buttons(current).find(b => b.text.startsWith(`❌ Eliminate ${t.order}.`))!;
        const pid = btn.callback_data!.split('_')[2];
        mark = calls.length;
        await tap(host, btn.callback_data!, dashId);
        const conf = latestDash(dashId, mark)!;
        check(`confirm for "${t.label}" is the dashboard edited in place`,
            textOf(conf) === `⚠️ Eliminate <b>${t.order}. ${t.label}</b>?` && buttons(conf).length === 2 && !calls.slice(mark).some(c => c.method === 'sendMessage'), textOf(conf));
        if (!cancelledOnce) {
            cancelledOnce = true;
            const noBtn = buttons(conf).find(b => b.text.includes('No'))!;
            mark = calls.length;
            await tap(host, noBtn.callback_data!, dashId);
            check('"No" sends no new message', !calls.slice(mark).some(c => c.method === 'sendMessage' || c.method === 'sendPhoto'));
            check('"No" toasts Cancelled', !!last(c => c.method === 'answerCallbackQuery' && c.body.text === 'Cancelled', mark));
            const back = latestDash(dashId, mark)!;
            check('"No" restores the normal dashboard', !!back && textOf(back).startsWith('📋 Game Dashboard') && buttons(back).some(b => b.text.startsWith(`❌ Eliminate ${t.order}.`)));
            await tap(host, btn.callback_data!, dashId);
        }
        mark = calls.length;
        await tap(host, `eliminate_${gameId}_${pid}`, dashId);
        check(`"☠️ ${t.label} has been eliminated."`, !!last(c => textOf(c) === `☠️ ${t.label} has been eliminated.`, beforeElim));
        check(`dashboard edited after eliminating "${t.label}"`, !!latestDash(dashId, mark));
    }

    const win = last(c => c.method === 'sendMessage' && c.body.chat_id === 1001 && textOf(c).startsWith('🏆'), beforeElim);
    check(`winner message sent (${opts.winner})`, !!win && textOf(win).startsWith(`🏆 ${opts.winner} win!`), win && textOf(win));
    check('winner message reached the real player', !!last(c => c.body.chat_id === 2002 && textOf(c).startsWith('🏆'), beforeElim));
    check('end-game summary uses labels', !!win && roster.filter(r => r.role !== 'Civilian').every(r => textOf(win).includes(`${r.label}: ${r.role}`)), win && textOf(win));
    const wonLobby = last(c => c.method === 'editMessageText' && textOf(c).includes(`${opts.winner} won!`), beforeElim);
    check('lobby edited with winner footer', !!wonLobby);
    const finalDash = latestDash(dashId, 0)!;
    check('final dashboard shows winner and full roster, no keyboard',
        textOf(finalDash).includes(`${opts.winner} win!`) && roster.every(r => textOf(finalDash).includes(`${r.label} - ${r.role}`)) && buttons(finalDash).length === 0
        && (finalDash.body.reply_markup?.inline_keyboard ?? []).length === 0, textOf(finalDash));
    check('final dashboard marks the dead and the living', textOf(finalDash).includes('💀') && textOf(finalDash).includes('💚'));
    check(`host sent /dashboard ${dashCommands} time(s) only`, dashCommands === (opts.redash ? 2 : 1));

    // Global invariants.
    const mine = calls.slice(start);
    check('no sendMessage contains "Confirm elimination" or "Elimination cancelled"',
        mine.every(c => c.method !== 'sendMessage' || !/Confirm elimination|Elimination cancelled/.test(textOf(c))));
    check('the game used exactly the dashboard message(s) sent by /dashboard',
        mine.filter(c => c.method === 'sendMessage' && c.body.chat_id === 1001 && /^(📋|🔒 Lock)/.test(textOf(c))).length === (opts.redash ? 2 : 1));
    check('no Telegram call targeted a test player (chat_id < 0)', mine.every(c => !(Number(c.body.chat_id) < 0)),
        JSON.stringify(mine.filter(c => Number(c.body.chat_id) < 0).map(c => c.method)));
    check('every text mentioning Bea shows (@girl) or (@girl_old)', mine.every(c => !/Bea/.test(textOf(c)) || /Bea \(@girl(_old)?\)/.test(textOf(c))),
        mine.filter(c => /Bea/.test(textOf(c)) && !/Bea \(@girl/.test(textOf(c))).map(firstLine).join(' | '));
    check('every button naming Bea shows (@girl)', mine.every(c => buttons(c).every(b => !/Bea/.test(b.text) || b.text.includes('(@girl'))));

    console.log('  -- Telegram call log --');
    printCalls(start);
};

(async () => {
    await scenario('Scenario 1: town eliminates the mafia (1 real + 3 test)', { extraTest: 3, winner: 'Civilians' });
    await scenario('Scenario 2: mafia wins (1 real + 5 test, renamed player, host re-sends /dashboard)', { extraTest: 5, winner: 'Mafia', staleName: true, redash: true });
    console.log(failures ? `\n${failures} assertion(s) FAILED` : '\nAll assertions PASSED');
    process.exit(failures ? 1 : 0);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
