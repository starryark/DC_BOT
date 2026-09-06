/** Whether a phrase cut leaves complete code/citation/numeric tokens. */
export function safeSpeechBoundary(text: string, cut: number, final = false): boolean {
  if (!Number.isInteger(cut) || cut < 0 || cut > text.length)
    return false
  let fenced = false
  let inline = false
  let square = 0
  let citation = 0
  let link = 0
  for (let i = 0; i < cut; i++) {
    if (text[i] === '\\') { i++; continue }
    if (text.slice(i, i + 3) === '```') { fenced = !fenced; i += 2; continue }
    if (fenced) continue
    if (text[i] === '`') { inline = !inline; continue }
    if (inline) continue
    if (text[i] === '[') square++
    if (text[i] === ']') square = Math.max(0, square - 1)
    if (text[i] === '【') citation++
    if (text[i] === '】') citation = Math.max(0, citation - 1)
    if (text[i] === '(' && (text[i - 1] === ']' || link > 0)) link++
    if (text[i] === ')' && link > 0) link--
  }
  if (fenced || inline || square || citation || link)
    return false
  if (cut > 0 && cut < text.length) {
    const left = text[cut - 1]
    const right = text[cut]
    if ((/[\d.,]/u.test(left) && /\d/u.test(right)) || (/\d/u.test(left) && /[.,%\d]/u.test(right)))
      return false
    if (/[\p{Script=Latin}\d]/u.test(left) && /[\p{Script=Latin}\d]/u.test(right))
      return false
    if (/[\uD800-\uDBFF]/u.test(left) || /\p{Mark}/u.test(right) || left === '\u200D' || right === '\u200D')
      return false
  }
  if (!final && cut === text.length && /(?:\d[.,]|[\p{Script=Latin}\d])$/u.test(text))
    return false
  return true
}
