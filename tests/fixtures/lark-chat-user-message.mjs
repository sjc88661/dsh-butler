// Exact upstream chatUserMessage; TypeScript annotations erased only.
// omdsh-dev/dsh-lark@632807d9abafbb866a5e208a0298eff21c7856d1, src/bridge.ts:683.
// BSD-3-Clause; full notice in dsh-lark.LICENSE. Bot branch is not exercised.
import { randomUUID } from 'node:crypto';
export function chatUserMessage(msg, images, inbound) {
    const spoken = msg.chatType === 'group'
        ? `${msg.senderName ?? msg.senderId}: ${msg.content}`
        : msg.content;
    // Only an agent's message carries the baton note: a human reads everything
    // said in their own chat, mention or not.
    const note = msg.senderIsBot === true ? batonNote(msg.senderId) : '';
    // Notes ride the text so a model that cannot be shown an image still knows
    // one was sent, instead of answering as though it had seen it. Files come
    // first: a path is something the model can act on, while an image note is
    // usually the reason it cannot see one.
    const text = [spoken, note, ...inbound.notes, ...images.notes].filter(line => line !== '').join('\n');
    const content = [
        ...text === '' ? [] : [{ type: 'text', text }],
        ...images.blocks,
    ];
    return Object.freeze({
        id: randomUUID(),
        role: 'user',
        content: Object.freeze(content),
        source: Object.freeze({ kind: 'user' }),
    });
}
