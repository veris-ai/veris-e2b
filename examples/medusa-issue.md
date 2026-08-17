Retrying a failed payment capture can charge the customer a second time

We run Medusa v2 with Stripe as the payment provider. Occasionally a capture call
to the provider fails in a way that leaves us unsure whether it went through — a
timeout, or our process going down between sending the request and reading the
response. When we retry the capture, the provider treats it as a brand-new
request rather than the same one, and we have seen the customer's card charged
twice for a single order.

Looking at the payment module, `PaymentModuleService.capturePayment` hands the
provider an idempotency key so that exactly this kind of retry can be
deduplicated on the provider's side; the Stripe provider does forward that key.
But the module seems to create a fresh capture record — with a fresh id — every
time `capturePayment` is called, and it deletes that record again if the provider
call throws. So a retry always arrives at the provider under a *different* key,
and the provider has no way to recognise it as a repeat.

The failure that triggers this is not one we can force on demand against
Stripe: it only shows up when the provider has already processed the request and
we never learned that. Reproducing it in an integration test means simulating a
provider that fails once (as a timeout would) and then succeeds, and calling
`capturePayment` twice for the same payment and amount — the key sent on the
second call is not the key sent on the first.

**Expected:** a retry of the same logical capture, after a provider-call failure,
reaches the provider under the same idempotency key as the original attempt, so a
provider that already processed it recognises the retry instead of capturing the
funds again.

**Actual:** every attempt mints a new capture record and therefore a new key,
whether or not the previous attempt failed ambiguously.
