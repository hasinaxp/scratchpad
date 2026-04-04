# JSON Pipeline Language (JPL) Specification


## 1. Overview
JPL is a deterministic, side-effect-free query language for JSON.

- It executes as a pipeline of steps.
- Each non-terminal step transforms a stream.
- Terminal `count(...)` returns a scalar and ends the pipeline.

## 2. Data Model
Supported values:

- `null`
- `boolean`
- `number`
- `string`
- `array`
- `object`

Context symbols:

- `$` root JSON value
- `@` current stream item

## 3. Query Shape
```
<query> ::= <source> ("|" <step>)*
<source> ::= "$" | <path>
<path> ::= <identifier> ("." <identifier>)*
```

Examples:

- `$ | map(@)`
- `users | filter(@.age >= 18)`
- `orders.items | flatten()`

## 4. Stream Initialization
JPL resolves source first, then creates stream:

- Source is `null`/`undefined` -> `[]`
- Source is array -> array elements stream
- Source is scalar/object -> single item stream

This means `users` where `users` is an array starts as each user item, not `[usersArray]`.

## 5. Tokens and Literals
Identifiers:
```
[A-Za-z_][A-Za-z0-9_]*
```

Literals:

- numbers: `1`, `-2`, `3.14`, `6e-2`
- strings: `"text"` with escapes (`\n`, `\t`, `\u0041`)
- booleans: `true`, `false`
- null: `null`

Operators:

- arithmetic: `+ - * /`
- comparison: `== != > < >= <=`
- logical: `&& || !`

Comments in query text are supported:

- line: `// ...`
- block: `/* ... */`

## 6. Expression Semantics
Truthiness used by `filter`, `&&`, `||`, `!`:

- falsey: `false`, `null`, `0`, `""`
- everything else is truthy

Path access:

- missing object field -> `null`
- invalid array index -> `null`
- path through non-object/non-array -> `null`

Arithmetic and comparisons are strict:

- mixed-type numeric operations -> `null`
- divide by zero -> `null`
- comparisons across incompatible types -> false-like behavior via runtime rules

## 7. Built-in Functions
Available in expressions:

- `length(x)`
- `contains(a, b)`
- `exists(x)`

Behavior:

- `length(array|string)` -> number, else `null`
- `contains(string,string)` -> boolean, else `null`
- `exists(x)` -> `x !== null`

Unknown function names are allowed at runtime (resolved from optional custom function context), and validation can emit warnings.

## 8. Pipeline Steps
Supported steps:

- `filter(expr)`
- `map(expr)`
- `limit(n)`
- `skip(n)`
- `at(n)`
- `slice(start, count)`
- `sort(path [asc|desc])`
- `flatten()`
- `flatten(path)`
- `distinct()`
- `distinct(path)`
- `count()` (terminal)
- `count(expr)` (terminal)

### 8.1 filter(expr)
Keeps items where `expr` is truthy.

### 8.2 map(expr)
Maps each item to evaluated result.

Supports object projection shorthand:

- `map({name})` means `{ name: @.name }`
- `map({name: @.name, adult: @.age >= 18})`

### 8.3 limit(n)
Keeps first `n` items (`n < 0` or non-number behaves as `0`).

### 8.4 skip(n)
Skips first `n` items (`n < 0` or non-number behaves as `0`).

### 8.5 at(n)
Keeps only item at index `n` as single-item stream.

- Out of range -> empty stream
- Negative/non-number -> empty stream

### 8.6 slice(start, count)
Keeps `count` items starting at `start`.

- Negative/non-number args clamp to `0`

### 8.7 sort(path [asc|desc])
Sorts by simple current path field.

- default order: `asc`
- null/missing keys sorted last
- stable behavior preserves input order for ties

### 8.8 flatten(path?)
- no arg: flattens one level of array items
- with field path: if field resolves to array, emits shallow copies replacing that field with each element

### 8.9 distinct(path?)
- no arg: de-duplicates by stable structural representation
- with path: de-duplicates by that extracted key

### 8.10 count(expr?)
Terminal step:

- `count()` -> stream length
- `count(expr)` -> number of truthy matches

No steps allowed after `count`.

## 9. Validation Rules
Validation checks include:

- known step names
- argument counts
- terminal-step placement (`count` must be last)
- `sort` field must be simple current-field path
- `sort` order must be `asc` or `desc`
- `flatten`/`distinct` optional field must be simple current-field path

Validation can also emit warnings:

- unknown function names in expressions

## 10. API
Exports:

- `parse(query, options?)`
- `validate(query, options?)`
- `compile(query, options?)`
- `execute(query, input, options?)`
- `run(compiled, input, options?)`
- `format(query, options?)`

`execute` return shape:

- success: `{ ok: true, value, warnings? }`
- failure: `{ ok: false, error, warnings? }`

Error object fields:

- `code`, `message`, `stage`
- optional `line`, `column`, `offset`, `stepIndex`, `details`

## 11. Execution Options
`execute(..., options)` supports:

- `maxSteps` (default `Infinity`)
- `maxOutputItems` (default `Infinity`)
- `context` object:
- `context.functions` for custom expression functions
- `context.variables` (reserved/pass-through for host usage)

## 12. Examples

### 12.1 Basic filtering
```jpl
users | filter(@.age >= 21)
```

### 12.2 Projection
```jpl
users | map({ name, country: @.profile.country })
```

### 12.3 Count terminal
```jpl
users | filter(@.active == true) | count()
```

### 12.4 Sorting
```jpl
users | sort(@.age desc)
```

### 12.5 skip + limit pagination
```jpl
users | skip(20) | limit(10)
```

### 12.6 slice window
```jpl
users | slice(5, 3)
```

### 12.7 at index
```jpl
users | at(0)
```

### 12.8 Distinct by field
```jpl
users | distinct(@.email)
```

### 12.9 Flatten nested arrays
```jpl
orders | flatten(@.items) | map({ orderId: @.id, sku: @.items.sku })
```

### 12.10 Root-based expression
```jpl
users | map({
  name,
  totalUsers: length($.users)
})
```

### 12.11 Filtering basics
```jpl
users | filter(@.name == "Alice")
```

```jpl
users | filter(@.age >= 21)
```

```jpl
users | filter(@.profile != null)
users | filter(exists(@.profile.city))
```

```jpl
users | filter(contains(@.name, "li"))
```

```jpl
users | filter(@.age >= 21 && @.active == true)
```

## 13. SSE / Mixed Content Host Guidance
For mixed documents (logs, SSE text + JSON chunks), run JPL per extracted JSON chunk in host code.

Recommended host flow:

1. Extract JSON chunks.
2. Parse each chunk to JSON value.
3. Run `execute(query, chunkValue, options)`.
4. Aggregate results for UI.

JPL itself queries JSON values, not raw mixed text.

## 14. Determinism Guarantees
JPL is deterministic by design:

- no time/random access
- no IO
- no side effects
- pure function style evaluation
