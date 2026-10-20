/** Where the machine-translated Arabic subtitle for `input` should go. */
export function outPathFor(input, explicit) {
    if (explicit) return explicit;
    let base = input.replace(/\.(ar|ara|arabic|en|eng|english)(\.(sub|tran|forced|sdh|hi|cc))?\.srt$/i, '');
    if (base === input) base = base.replace(/\.srt$/i, '');
    return `${base}.ar.tran.srt`;
}
