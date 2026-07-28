# Interpolation and props (script/style)

## Text and attribute interpolation

- **Single braces:** `{ expression }` is one interpolation; the expression is evaluated at render time and the result is used (stringified in text, or as the value in attributes). Adjacent `{{` is nested JS (Svelte-style), e.g. object literals: `props="{{ foo: 1 }}"`.
- **Literal braces:** use a string expression (`{ '{…}' }`) or HTML entities (`&#123;` / `&#125;`). There is no `{{` escape dialect.

## Auto-escaping

Text interpolations are automatically HTML-escaped to prevent XSS attacks:

```html
<script is:build>
  const name = '<script>alert("xss")</script>';
</script>
<p>Hello { name }</p>
```

Output: `<p>Hello &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>`

### Raw output

Use `raw()` to bypass escaping when you need to output raw HTML:

```html
<script is:build>
	const html = '<strong>bold</strong>'
</script>
<p>{ raw(html) }</p>
```

Output: `<p><strong>bold</strong></p>`

## Loops (`for` / `for`)

Use a JavaScript **for…of** head inside braces: `for="{ const item of items }"`. Destructuring is supported (e.g. `const { name, id } of users`).

Inside the loop body, **`index`**, **`first`**, **`last`**, and **`length`** are always injected (0-based index; `length` is the iterable’s `.length`, so it is only meaningful for array-like values).

```html
<script is:build>
	const items = ['a', 'b', 'c']
</script>
<ul>
	<li for="{ const item of items }">
		{ item } (index: { index }, first: { first }, last: { last }, length: { length })
	</li>
</ul>
```

If your binding pattern declares a name that collides with the injected metadata (e.g. `const { length } of rows`), it **shadows** the injected `length` inside that iteration.

To repeat a fragment **without** an extra wrapper element, put `for` / `for` on **`<template>`** so only the inner markup is emitted — see [HTML `<template>` — Wrapperless loops](html-template-element.md).

## props (script and style)

The `props` attribute on `<script>` and `<style>` uses the **same idea**: one braced expression, evaluated at render time. The value must be braced (`{ ... }`) and is used **as-is** (no extra "strip one level" rule). The expression must evaluate to an object; in script its keys become globals, in style they become CSS custom properties (e.g. `--fg`, `--bg`). Bare `props` (no value) spreads a local `props` variable.

| What you want                               | props value                 | Result                                      |
| ------------------------------------------- | --------------------------- | ------------------------------------------- |
| One variable as one key                     | `props="{ theme }"`         | One key `"theme"` (e.g. `--theme` in style) |
| Object's properties as keys (e.g. CSS vars) | `props="{ ...theme }"`      | Keys of `theme` → `--fg`, `--bg`, etc.      |
| Multiple variables                          | `props="{ title, accent }"` | Keys `title`, `accent`                      |

So to use an object's properties as CSS variables, use **spread**: `props="{ ...theme }"`. Using `props="{ theme }"` passes the whole object as a single key, not its properties.
