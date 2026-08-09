---
type: investigation
symptom: "OpenAI rejects the Pi ftown_mail tool because its parameters are not a top-level object schema"
slug: pi-ftown-tool-schema-rejected
date: 2026-08-09T17:59:12-03:00
investigator: Foad Kesheh
git_commit: 3ffac51800ad72a96467fdb917d7b7dc77a2d664
branch: feat/pi-ftown-tools
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/presubmit-report.md
---

# Pi ftown tool schema is rejected by OpenAI

## Symptom

- **Observed**: `Error: 400: {"message":"Invalid schema for function 'ftown_mail': schema must be a JSON Schema of 'type: \"object\"', got 'type: null'.","type":"invalid_request_error","param":null,"code":"invalid_request_error"}`
- **Expected**: Pi should send a prompt with `ftown_mail` enabled and receive a model response.
- **Delta**: the provider rejects the request before inference because `ftown_mail.parameters` has no top-level `type: "object"` and uses a top-level union.

## Reproduction

Environment: Pi 0.83.0, Node 24.12.0, published `ftown-bridge@0.19.8`, OpenAI `gpt-4.1-mini`.

1. Load only the shipped extension and enable only `ftown_mail`:

   ```sh
   pi --provider openai --model gpt-4.1-mini \
     --extension ./bridge/pi-extension/ftown.js \
     --no-extensions --no-skills --no-context-files --no-session \
     --tools ftown_mail --print 'Reply only OK.'
   ```

2. Verified on 2026-08-09:

   ```text
   OpenAI API error (400): {"message":"Invalid schema for function 'ftown_mail': schema must be a JSON Schema of 'type: \"object\"', got 'type: \"None\"'.","type":"invalid_request_error","param":"tools[0].parameters","code":"invalid_function_parameters"}
   ```

3. Capturing registered tool schemas before any provider serialization produces:

   ```json
   [
     { "name": "ftown_mail", "type": null, "hasAnyOf": true },
     { "name": "ftown_sessions", "type": null, "hasAnyOf": true },
     { "name": "ftown_session_create", "type": "object", "hasAnyOf": false },
     { "name": "ftown_session_manage", "type": null, "hasAnyOf": true },
     { "name": "ftown_loops", "type": null, "hasAnyOf": true }
   ]
   ```

## Hypotheses

#### H1: Operation-discriminated tools use provider-incompatible top-level `anyOf` schemas instead of one top-level object

- **Layer**: dependency/integration
- **Prediction**: The raw registered schema will have no top-level object type; adding only the type will expose a top-level-union rejection; replacing the top-level union with a flat object will let the identical real-provider request proceed.
- **Verification method**: inspect `bridge/pi-extension/ftown.js:259-289`, capture schemas through a mock registration boundary, then run two one-variable counterfactual extensions against OpenAI.
- **Evidence**:

  ```text
  Raw: { "name": "ftown_mail", "type": null, "hasAnyOf": true }
  Type-only counterfactual: Invalid schema for function 'ftown_mail': schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the top level.
  Flat-object counterfactual: OK
  ```

- **Verdict**: PROVEN
- **Rationale**: The live OpenAI request changes from two deterministic schema errors to success only when the top-level union is replaced by an object schema.

#### H2: Pi strips a valid top-level `type` while registering or serializing the extension tool

- **Layer**: tooling/build
- **Prediction**: The extension source will declare `type: "object"`, but a capture after `registerTool` or provider serialization will lose it.
- **Verification method**: intercept `registerTool` directly, before Pi or provider serialization.
- **Evidence**:

  ```text
  bridge/pi-extension/ftown.js:263
  parameters: {
    anyOf: [

  captured ftown_mail type: null
  ```

- **Verdict**: REJECTED
- **Rationale**: The type is absent in the extension-owned object before Pi receives it; Pi cannot be the component that removed it.

#### H3: The published 0.19.8 package contains an older schema than the reviewed repository source

- **Layer**: state/data
- **Prediction**: The npm tarball extension hash or schema will differ from the branch copy.
- **Verification method**: pack `ftown-bridge@0.19.8`, hash its extension, and compare it with the branch file.
- **Evidence**:

  ```text
  repository: 3eea1c9285bb16a5bfc93a9b65368ff16e219291765505678901609eb809b5f4
  npm tarball: 3eea1c9285bb16a5bfc93a9b65368ff16e219291765505678901609eb809b5f4
  tarball schema begins: parameters: { anyOf: [
  ```

- **Verdict**: REJECTED
- **Rationale**: The published and repository extension bytes are identical, so publication skew does not explain the failure.

## 5 Whys

Symptom: OpenAI rejects `ftown_mail` before inference.  
Why 1? Its parameters schema has no top-level object type and has `anyOf` at the top level.  
Why 2? Multi-operation tools were represented as discriminated unions of operation-specific objects.  
Why 3? The extension optimized for local validation precision without applying the provider-facing tool-schema compatibility constraints.  
Why 4? Tests captured mocked `registerTool` objects and exercised handlers, but did not validate every schema or make a real provider request.  
Why 5? The new extension had no cross-provider schema contract gate or native Pi/provider smoke test in the release path.

## Falsification

- **Check performed**: counterfactual isolation against the real OpenAI provider.
- **Result**: adding `type: "object"` while retaining top-level `anyOf` still failed with the more specific top-level-combinator error. Flattening only `ftown_mail` into one object schema made the same Pi/OpenAI command return `OK` with exit code 0.
- **Conclusion**: H1 survived and was refined: both the missing object type and the top-level union shape are causal; merely adding a type is insufficient.

## Root Cause

- **Immediate cause**: four model-facing tools declare operation variants with top-level `anyOf` (`bridge/pi-extension/ftown.js:264`, `:372`, `:520`, `:629`), which is outside OpenAI's accepted function-parameter root shape.
- **Architectural root**: provider portability was not encoded as a testable schema invariant, and the registration tests stopped at a permissive mock boundary.
- **Rejected H2**: direct registration capture proves the missing type originates in extension source, not Pi serialization.
- **Rejected H3**: the npm artifact and branch extension have identical SHA-256 hashes and schema bytes.
- **Falsification result**: the actual provider accepted the flat-object counterfactual and rejected both the original and type-only variants.

## Fix

- Replace each top-level operation union with one `type: "object"` schema whose `operation` is a string enum and whose operation-specific fields are optional at the provider boundary.
- Preserve operation-specific required-field validation in `execute` before any request or mutation.
- Add a regression test that asserts every registered tool has a top-level object schema without top-level combinators, plus operation-validation tests for required fields.
- Re-run the exact Pi/OpenAI reproduction with every ftown tool enabled.

The confirmed test seams are the public Pi extension registration boundary (`registerTool`), the public tool execution boundary (`execute`), and the native Pi-to-provider request. The user's provider error directly identified the third seam as the missing release-level coverage.

## Resolution

- **Diff summary**: all five tools now expose provider-compatible root object schemas; operation variants use string enums and optional operation-specific properties. Conditional required fields and interval/cron schedule requirements are validated before any bridge request. The package version is 0.19.9.
- **Regression tests**: `bridge/src/pi-extension.test.ts` asserts every registered tool schema has an object root without forbidden root combinators and verifies incomplete operation arguments fail before network access.
- **Native verification**: the exact original Pi/OpenAI command fails on 0.19.8. With the corrected extension, Pi 0.83.0 and OpenAI `gpt-4.1-mini` return `OK` with all five ftown tools enabled.
- **Suite verification**: 14 focused extension tests pass; the full bridge suite passes with 571 tests; TypeScript build and `npm pack --dry-run` pass; the package manifest reports `ftown-bridge-0.19.9.tgz`.
- **Follow-up**: keep the provider-compatible schema invariant in the extension test suite so future tools cannot regress to a root union.
