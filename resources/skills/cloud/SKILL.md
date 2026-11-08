---
name: cloud
description: >
  Integrates Roblox Open Cloud, server HTTP calls, external backends, secrets, and recoverable webhook workflows. Use when asked to "call an external API", "set up Open Cloud", "store an API key", "receive Roblox webhooks", "build a serverless backend", or "fix HTTP retries".
---

# Roblox Cloud and Backend Services

## When to use

- Calling approved external services from Roblox server code.
- Building external automation with supported Open Cloud APIs.
- Designing backend queues, webhooks, and idempotent operations.
- Diagnosing authentication, throttling, schema, and partial-failure problems.

## When NOT to use

- Designing the in-game remote protocol; that belongs to networking.
- Writing a basic cached player profile; that belongs to data.
- Enabling Studio's local MCP connection; that belongs to studio-mcp.

## Core instructions

### 1. Define direction, authentication, and authority

1. Distinguish Roblox-to-backend HttpService calls from external Open Cloud calls.
2. ALWAYS verify that the selected endpoint supports the intended authentication and execution context.
3. Use API keys with least privilege or OAuth 2.0 for appropriate delegated applications.
4. NEVER use a user's Roblox session cookie as a production backend credential.
5. Keep tokens in a backend secret manager or Roblox's supported secrets store.
6. Do not put secrets in ReplicatedStorage, attributes, logs, source control, or player data.
7. Restrict server destinations to an allowlist; NEVER fetch arbitrary player-provided URLs.
8. HttpService does not expose a public inbound HTTP listener for a running game server.

### 2. Make authenticated requests safely

- Enable HTTP requests only in the intended environment and test local secrets separately.
- Use HttpService:GetSecret on the server and pass Secret values through supported headers or URLs.
- Prefer headers over query strings for credentials.
- NEVER attempt to extract or serialize a Secret value into JSON.
- Wrap RequestAsync and JSON decoding in pcall and validate response shape afterward.
- A successful transport call can still return an unsuccessful HTTP status.
- Bound request frequency and response size before expensive processing.

This server example reads the current universe through a supported Open Cloud route.
Create a suitably scoped UniverseReadKey secret restricted to apis.roblox.com.
Verify the current endpoint's permissions and in-experience availability before enabling it.

```luau
--!strict
local HttpService = game:GetService("HttpService")
assert(game.GameId > 0, "A published universe is required")

local ok, response = pcall(function()
    return HttpService:RequestAsync({
        Url = "https://apis.roblox.com/cloud/v2/universes/" .. game.GameId,
        Method = "GET",
        Headers = {["x-api-key"] = HttpService:GetSecret("UniverseReadKey")},
    })
end)

if not ok then
    warn("Universe read transport failed")
elseif not response.Success then
    warn("Universe read rejected", response.StatusCode)
elseif #response.Body > 64_000 then
    warn("Universe read response exceeded the expected size")
else
    local decoded, payload = pcall(function()
        return HttpService:JSONDecode(response.Body)
    end)
    if decoded and type(payload) == "table" then
        print("Universe response received")
    else
        warn("Universe response schema is invalid")
    end
end
```

### 3. Design retries around unknown outcomes

- GET-like reads can usually be retried with bounded exponential backoff and jitter.
- Mutating requests MUST have an application-level idempotency contract before automatic retry.
- Reuse the same stable operation ID after a timeout or lost response.
- Honor Retry-After and documented endpoint quotas where exposed.
- NEVER retry authentication errors or invalid schemas forever.
- Use a bounded queue and circuit-breaker policy when the external service is unavailable.
- Core gameplay should degrade deliberately rather than waiting indefinitely on a backend.
- A local request deadline does not prove a remote mutation did not happen.

This example posts to an illustrative owned backend endpoint.
Replace the example domain with the project's approved HTTPS domain and secret restriction.
The backend MUST store the operation ID with its effect and return the same result on replay.

```luau
--!strict
local HttpService = game:GetService("HttpService")

local function submitOperation(operationId: string, kind: string): (boolean, number?)
    assert(#operationId >= 1 and #operationId <= 64)
    assert(kind == "RefreshCatalog")
    local ok, response = pcall(function()
        return HttpService:RequestAsync({
            Url = "https://backend.example.com/v1/operations",
            Method = "POST",
            Headers = {
                ["Content-Type"] = "application/json",
                ["Authorization"] = HttpService:GetSecret("BackendKey"):AddPrefix("Bearer "),
                ["Idempotency-Key"] = operationId,
            },
            Body = HttpService:JSONEncode({version = 1, operationId = operationId, kind = kind}),
        })
    end)
    if not ok then return false, nil end
    return response.Success, response.StatusCode
end

return submitOperation
```

### 4. Verify webhooks at the external boundary

- Terminate inbound webhooks at an external HTTPS backend with the provider's documented verification.
- Verify signatures against the exact raw request bytes before parsing or acting.
- Use the provider's real algorithm and headers; NEVER invent a shared webhook signature format.
- Check replay windows and deduplicate durable event IDs before granting valuable effects.
- Respond promptly after durable enqueue; process expensive work in a worker.
- Expect duplicate, delayed, and out-of-order events.
- Use an authenticated queue or authoritative store for work the game must apply later.
- MessagingService notifications are hints, not a substitute for durable delivery.

This Roblox-side parser validates an already-authenticated backend response envelope.
It does not verify a webhook signature and MUST NOT be used as authentication.
The example allows configuration invalidation only, not currency or item grants.

```luau
--!strict
local HttpService = game:GetService("HttpService")
type Invalidation = {key: string, revision: number}
local allowed: {[string]: boolean} = {ShopRotation = true, EventSchedule = true}

local function parseInvalidation(body: string): Invalidation?
    if #body > 4_096 then return nil end
    local ok, value = pcall(function() return HttpService:JSONDecode(body) end)
    if not ok or type(value) ~= "table" or value.version ~= 1 then return nil end
    if type(value.key) ~= "string" or not allowed[value.key] then return nil end
    local revision = value.revision
    if type(revision) ~= "number" or revision % 1 ~= 0 then return nil end
    if revision < 0 or revision > 1_000_000_000 then return nil end
    return {key = value.key, revision = revision}
end

assert(parseInvalidation('{"version":1,"key":"ShopRotation","revision":2}') ~= nil)
assert(parseInvalidation('{"version":1,"key":"Wallet","revision":2}') == nil)
```

### 5. Operate external integrations

- Scope API keys to the selected universe and resource whenever the endpoint supports it.
- Store OAuth refresh tokens externally, rotate credentials, and support revocation.
- Record status code, latency, operation ID, and sanitized error category.
- NEVER log Authorization, x-api-key, raw secret-bearing URLs, or full private response bodies.
- Separate staging and production endpoints, keys, and queues.
- Test revoked credentials, throttling, invalid JSON, duplicate operations, and backend downtime.
- Review offline data changes against the active player-session ownership protocol.
- Document the endpoint contract, permissions, retry deadline, and recovery owner.

## Common mistakes

- Sending a secret to the client; keep authenticated calls in server or backend code.
- Retrying a payment-like POST with a new ID; reuse the original durable operation ID.
- Trusting a webhook after JSON parsing alone; authenticate raw bytes before processing.
- Assuming Roblox can receive inbound HTTP directly; use an external backend and delivery workflow.
- Treating RequestAsync success as HTTP success; inspect both transport status and response.Success.

## Reference

- [Open Cloud](https://create.roblox.com/docs/cloud).
- [In-game HTTP requests](https://create.roblox.com/docs/cloud-services/http-service).
- [Secrets stores](https://create.roblox.com/docs/cloud-services/secrets).
