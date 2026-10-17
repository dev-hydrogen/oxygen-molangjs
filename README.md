# MolangJS (Bedrock-faithful)

Molang parser, compiler, analyzer and formatter for JavaScript/TypeScript, matching what Minecraft
Bedrock Edition actually evaluates — including its versioned behaviour changes.

```ts
import { compile, createEnv, evaluate, SymbolTable } from 'molangjs';

const symbols = new SymbolTable();
const expr = compile('v.a = math.sin(90); return v.a * 2;', { symbols });
const env = createEnv({ err: (code, node) => console.warn(code, node) });
evaluate(expr, env); // 2
```

The classic API still works:

```js
import Molang from 'molangjs';
new Molang().parse('v.x + 1', { 'variable.x': 2 }); // 3
```

## Bedrock semantics

- Precedence (C-like): `!` > `* /` > `+ -` > `< <= > >=` > `== !=` > `&&` > `||` > `?:` (right-assoc) > `??`.
- Versioned changes: pre-1.18.10 left-associative ternary, pre-1.18.20 `&&`/`||` and comparison
  grouping, pre-1.19.60 negative-divisor bug. Pass `version` (see `molangVersionForEngine`).
- A multi-statement ("complex") expression evaluates to its `return` value, or `0.0` without one.
- Identifiers are case-insensitive; strings keep case and whitespace.
- Unset reads evaluate to `0.0` and raise a content error; `??` supplies a default.
- Division by zero is `0.0` + content error; `NaN` propagates; `math.sign(0)` is `-1`;
  `math.round` rounds halves away from zero; `loop` is capped at 1024 iterations.
- Optional float32 emulation (`f32`, on by default) rounds every operation like the game.
- `t.*` lives in a `TempScope` the caller owns, so an engine can model temp leaking.

## API

- `parse(source, { version, comments })` → `{ program, diagnostics }` with source spans.
- `compile(source, { symbols, version, f32, mode })` → JS function. `mode: 'trace'` reports every
  intermediate value; `mode: 'step'` returns a generator that pauses at each statement.
- `analyze(program)` → reads/writes in evaluation order, query call signatures, lint diagnostics.
- `format(program, { style: 'pretty' | 'spaced' | 'compact' })`.
