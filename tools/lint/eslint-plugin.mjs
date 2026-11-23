// @ts-check
// Local ESLint plugin: keeps color literals out of the renderer's strings and templates, and
// (Huli) Tailwind variants that restyle whole subtrees out of its classes and the upstream
// product's name out of the phone app's text.
import { colorLiteralMessage, findColorLiterals } from './color-literals.mjs'

/** @type {import('eslint').Rule.RuleModule} */
const noColorLiterals = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow color literals outside the token file' },
    schema: [],
    messages: { literal: '{{ message }}' },
  },
  create(context) {
    const { sourceCode } = context

    /**
     * @param {import('eslint').Rule.Node} node
     * @param {string} text the cooked or raw text that was scanned
     * @param {number} offset where `text` starts in the source, or -1 when it cannot be mapped
     */
    function check(node, text, offset) {
      for (const { index, match } of findColorLiterals(text)) {
        const loc = offset < 0 ? node.loc : sourceCode.getLocFromIndex(offset + index)
        context.report({
          node,
          loc: loc ?? node.loc ?? undefined,
          messageId: 'literal',
          data: { message: colorLiteralMessage(match) },
        })
      }
    }

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return
        // The offset only maps when the source holds the value as written, without escapes.
        const raw = node.raw ?? ''
        const plain = raw.length === node.value.length + 2
        check(node, node.value, plain && node.range ? node.range[0] + 1 : -1)
      },
      TemplateElement(node) {
        check(node, node.value.raw, node.range ? node.range[0] + 1 : -1)
      },
    }
  },
}

/**
 * Huli: the phone app is 纸鸢 and its account service Kite Cloud, so no text it shows may say
 * Kettu. Strings compared against what the host sends are code, not text, and attribution that
 * must name the upstream (the license, the source link) disables the rule where it stands.
 * @type {import('eslint').Rule.RuleModule}
 */
const noUpstreamName = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow the upstream product name in user-facing text' },
    schema: [],
    messages: { name: 'Say 纸鸢 (or Kite Cloud for the account service), not Kettu.' },
  },
  create(context) {
    const NAME = /Kettu/

    /** @param {import('eslint').Rule.Node} node */
    function comparedOrImported(node) {
      const parent = node.parent
      if (!parent) return false
      if (parent.type === 'BinaryExpression') return true
      if (parent.type === 'SwitchCase' && parent.test === node) return true
      return parent.type === 'ImportDeclaration' || parent.type === 'ExportAllDeclaration'
    }

    return {
      Literal(node) {
        if (typeof node.value !== 'string' || !NAME.test(node.value)) return
        if (comparedOrImported(node)) return
        context.report({ node, messageId: 'name' })
      },
      TemplateElement(node) {
        if (NAME.test(node.value.raw)) context.report({ node, messageId: 'name' })
      },
      /** @param {any} node */
      JSXText(node) {
        if (NAME.test(node.value)) context.report({ node, messageId: 'name' })
      },
    }
  },
}

/**
 * Huli: Tailwind's group and peer state variants compile to .x:is(:where(.group):hover *), and
 * with any rule of that shape in the page Chromium restyles the whole subtree of every element
 * whose hover, focus or contents change. The plain variants in globals.css say the same; the
 * unnamed group-hover is redefined there and so stays allowed.
 * @type {import('eslint').Rule.RuleModule}
 */
const noGroupStateVariant = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow group and peer state variants that restyle whole subtrees' },
    schema: [],
    messages: {
      variant:
        '{{ variant }} restyles a whole subtree on every change: use the plain variants in styles/globals.css (hover-<group>:, focus-within-<group>:, focus-visible-<group>:) or an arbitrary [[data-slot=x]:has(...)_&]: variant.',
    },
  },
  create(context) {
    const VARIANT =
      /(?<![\w-])(?:group-hover\/[\w-]+|(?:group|peer)-(?:focus|focus-within|focus-visible|active)(?:\/[\w-]+)?|peer-hover(?:\/[\w-]+)?|(?:group|peer)-has-[^\s:'"`]*)(?=:)/

    /** @param {import('eslint').Rule.Node} node @param {string} text */
    function check(node, text) {
      const match = VARIANT.exec(text)
      if (match) context.report({ node, messageId: 'variant', data: { variant: match[0] } })
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value)
      },
      TemplateElement(node) {
        check(node, node.value.raw)
      },
    }
  },
}

export const rules = {
  'no-color-literals': noColorLiterals,
  'no-upstream-name': noUpstreamName,
  'no-group-state-variant': noGroupStateVariant,
}

export default { meta: { name: 'kettu' }, rules }
