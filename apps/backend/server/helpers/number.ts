export function validateInteger(num: number, min: number, max: number) {
    const numTmp = num;
    if (String(numTmp) !== String(num) || numTmp < min || numTmp > max)
        return undefined;
    return numTmp;
}

export function validatePortNo(num: number | undefined) {
    if (!num) return undefined;
    return validateInteger(num, 1, 0xffff);
}
