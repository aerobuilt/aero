---
published: true
title: Props
subtitle: Pass and receive data in components with attributes and props.
---

Aero’s props system lets you pass data into components and layouts via attributes or `props`, and read it in build scripts from `Aero.props`.

## Core concept

All props are read from **Aero.props** in `<script is:build>{:html}`. Destructure what you need.

## How attribute values work

- **Normal attributes** are string literals unless you wrap the value in `{ ... }`. Use `{ expression }` for booleans, numbers, or computed values.
- **Directives** (`if`, `else-if`, `else`, `for`) need brace-wrapped expressions, e.g. `<p if="{ condition }">{:html}`, `<p for="{ const item of items }">{:html}`. Unbraced values are invalid.
- **props:** `<my-component props="{ ...data }">{:html}` spreads the object’s keys as props. `<my-component props="{ data }">{:html}` passes the object as one prop named `data`. `props` with no value spreads a local variable named `props`. Without braces, non-strings become strings and can cause bugs.

## Passing props

**1. String literals**

```html
<my-component title="Hello" count="42" />
```

**2. Expressions**

Use `{ }` for JavaScript expressions:

```html
<my-component title="{ site.meta.title }" count="{ 2 * 21 }" />
```

Compose strings with inline expressions:

```html
<my-component title="Slug: { Aero.page.params.slug }" />
```

Use a string expression to output literal `{` and `}` in strings:

```html
<my-component title="{ '{ slug } + ' + Aero.page.params.slug }" />
```

**3. Spread with props**

```html
<script is:build>
	const myProps = { title: 'Hello', count: 42 }
</script>

<my-component props="{ ...myProps }" />
```

The value must be a brace-wrapped expression (e.g. `"{ ...myProps }"`, not `"myProps"`).

**4. Inline object**

```html
<my-component props="{ title: 'Hello', count: 42 }" />
<my-component props="{ title: site.meta.title.toUpperCase(), count: 2 * 21 }" />
```

**5. Shorthand (spread local props)**

Use `props` with no value to spread a variable named `props` in scope:

```html
<script is:build>
	const props = { title: 'Hello', count: 42 }
</script>

<my-component props />
```

**6. Mixed**

```html
<my-component props="{ ...baseProps }" extra="value" override="{ computed }" />
```

## Receiving props

Destructure from `Aero.props`:

```html
<script is:build>
	const { title, subtitle } = Aero.props
</script>

<header>
	<h1>{ title }</h1>
	<p>{ subtitle }</p>
</header>
```

With defaults:

```html
<script is:build>
	const { title = 'Default Title', subtitle } = Aero.props
</script>
```

With fallbacks to site data:

```html
<script is:build>
	const { title, description } = Aero.props
</script>
<meta property="og:title" content="{ title || site.meta.title }" />
<meta property="og:description" content="{ description || site.meta.description }" />
```

## Available globals

Inside `<script is:build>{:html}` you have:

- **Aero.props** — Props passed to this component
- **Aero.page.request** — Current request object
- **Aero.page.url** — Current page URL
- **Aero.page.params** — Route params for dynamic routes
- **site** — Global site data (from your content module, e.g. `content/site.ts` or `@content/site`)
- **slots** — Named and default slot content
- **renderComponent** — Function to render child components

**Dev vs static:** In dev or API runtime, `Aero.page.request` is the real request and `Aero.page.url` / `Aero.page.params` reflect the current route. In a static build, the request is synthetic (headers may be missing), and `Aero.page.url` / `Aero.page.params` are set per generated page. Use them for canonical links and route-based content.

## Examples

**Simple component** (e.g. `client/components/greeting.html`):

```html
<script is:build>
	const { name } = Aero.props
</script>

<h1>Hello, { name }!</h1>
```

Usage: `<greeting-component name="World" />{:html}`

**Computed props** (e.g. in `client/pages/index.html`):

```html
<script is:build>
	import header from '@components/header.html'
	const headerProps = {
		title: site.home.title,
		subtitle: site.home.subtitle.toUpperCase(),
	}
</script>

<header-component props="{ ...headerProps }" />
```

**Mixed props:**

<!-- prettier-ignore -->
```html
<my-component 
	props="{ title: site.meta.title, count: 42 }" 
	extra="static value" 
	computed="{ someExpression }" />
```
