# Props System Guide

Aero provides a flexible, Astro-inspired props system for component composition.

## Core Concept

**All props are accessed via `Aero.props`** — the single source of truth in build scripts. Components destructure what they need from `Aero.props`.

## How attribute values work

- **Normal attributes** are **string literals** unless you wrap the value in `{ ... }`. Use `{ expression }` to pass booleans, numbers, or computed values.
- **Directives** (`if`, `else-if`, `else`, `for`, `switch`) require brace-wrapped expressions where applicable: e.g. `if="{ condition }"`, `for="{ const item of items }"`, `switch="{ state }"`. `case` accepts a string literal (`case="active"`) or a braced expression (`case="{ expr }"`); grouped cases use an array: `case="{ ['a', 'b'] }"`. `default` is a bare attribute (like `else`). Unbraced values are invalid where the directive expects `{ … }`. On **`<template>`**, `if` / `for` / `switch` compile to **wrapperless** output (children only); see [html-template-element.md](html-template-element.md).
- **`props`** — `props="{ ...data }"` spreads the object’s keys as props. `props="{ data }"` passes the object as a single prop named `data`. `props` with no value spreads a local variable named `props`. Without braces, non-string values become strings and can cause type bugs.

## Passing Props to Components

There are **four ways** to pass props to components:

### 1. Individual Attributes (String Literals)

```html
<my-component title="Hello" count="42" />
```

### 2. Individual Attributes (Expressions)

Use `{ }` to evaluate JavaScript expressions:

```html
<my-component title="{ site.meta.title }" count="{ 2 * 21 }" />
```

You can also compose strings with inline expressions:

```html
<my-component title="Slug: { Aero.page.params.slug }" />
```

If `Aero.page.params.slug === 'intro'`, `title` becomes `Slug: intro`.

To render literal braces in composed strings, use a string expression (or HTML entities):

```html
<my-component title="{ '{ slug } + ' + Aero.page.params.slug }" />
```

If `Aero.page.params.slug === 'intro'`, `title` becomes `{ slug } + intro`.

Adjacent `{{` is nested JS (e.g. an object literal), not an escape: `props="{{ foo: 1 }}"`.

### 3. Spread Syntax

Spread an existing object using `props`:

```html
<script is:build>
	const myProps = { title: 'Hello', count: 42 }
</script>
<my-component props="{ ...myProps }" />
```

The value must be a brace-wrapped expression. For example, `props="myProps"` is invalid; use `props="{ ...myProps }"`.

### 4. Inline Object Literals

Define props inline with `props`:

```html
<my-component props="{ title: 'Hello', count: 42 }" />
```

You can use expressions:

```html
<my-component props="{ title: site.meta.title.toUpperCase(), count: 2 * 21 }" />
```

### 5. Shorthand (spread local `props`)

Use `props` with no value to spread a variable named `props` in scope:

```html
<script is:build>
	const props = { title: 'Hello', count: 42 }
</script>
<my-component props />
<!-- Equivalent to: props="{ ...props }" -->
```

### 6. Mixed Approach

Combine `props` with individual attributes:

```html
<my-component props="{ ...baseProps }" extra="value" override="{ computed }" />
```

## Receiving Props in Components

Components access props by destructuring `Aero.props`:

```html
<script is:build>
	const { title, subtitle } = Aero.props
</script>

<header>
	<h1>{ title }</h1>
	<p>{ subtitle }</p>
</header>
```

### With Defaults

```html
<script is:build>
	const { title = 'Default Title', subtitle } = Aero.props
</script>
```

### With Fallbacks to Site Data

```html
<script is:build>
	const { title, description } = Aero.props
</script>

<meta property="og:title" content="{ title || site.meta.title }" />
<meta property="og:description" content="{ description || site.meta.description }" />
```

## Available Globals

Inside `<script is:build>` you have access to:

- **`Aero.props`** — Props passed to this component
- **`Aero.page.request`** — Current request object
- **`Aero.page.url`** — Current page URL
- **`Aero.page.params`** — Route params for dynamic routes
- **`site`** — Global site data (from your content module, e.g. `content/site.ts`, imported via `@content/site`)
- **`slots`** - Named and default slot content
- **`renderComponent`** - Function to render child components

## Request/URL/Params Examples

### Dev vs Static behavior

| Global              | Dev server / API runtime                               | Static build (`pnpm build` HTML output)                    |
| ------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| `Aero.page.request` | Real incoming request (method + forwarded headers)     | Synthetic request; request-specific headers may be missing |
| `Aero.page.url`     | URL for the current incoming route                     | URL derived from the generated page route                  |
| `Aero.page.params`  | Populated for dynamic route files (e.g. `[slug].html`) | Only populated when rendering dynamic route pages          |

### Read request metadata

```html
<script is:build>
	const userAgent = Aero.page.request.headers.get('user-agent') || 'unavailable'
</script>

<p>User agent: { userAgent }</p>
```

In local dev/server rendering, request headers are forwarded from the incoming request.
In static builds, request-specific headers may be unavailable.

### Build canonical links from the current URL

```html
<script is:build>
	const canonical = new URL(Aero.page.url.pathname, Aero.site.url || '').toString()
</script>

<link rel="canonical" href="{ canonical }" />
```

### Use dynamic route params

In a dynamic route file such as `client/pages/docs/[slug].html`:

```html
<script is:build>
	const slug = Aero.page.params.slug || 'index'
</script>

<h1>Docs: { slug }</h1>
```

## Examples

### Simple Component

```html
<!-- client/components/greeting.html -->
<script is:build>
	const { name } = Aero.props
</script>

<h1>Hello, { name }!</h1>
```

Usage:

```html
<greeting-component name="World" />
```

### Component with Computed Props

```html
<!-- client/pages/index.html -->
<script is:build>
	import header from '@components/header.html'

	const headerProps = {
		title: site.home.title,
		subtitle: site.home.subtitle.toUpperCase(),
	}
</script>

<header-component props="{ ...headerProps }" />
```

### Component with Mixed Props

```html
<my-component
	props="{ title: site.meta.title, count: 42 }"
	extra="static value"
	computed="{ someExpression }" />
```
