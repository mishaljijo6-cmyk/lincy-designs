# LINCY DESIGNS deployment notes

This is the standalone LINCY storefront and Vercel API project. Deploy it from the `main` branch of `mishaljijo6-cmyk/lincy-designs` to the existing Vercel project that serves `https://lincydesigns.vercel.app`. Vercel serves static files from `public/`; API functions remain in `/api`.

## Before enabling checkout

1. In Supabase SQL Editor, apply these files in order:
   1. `schema.sql` (only if the base store schema has not already been installed)
   2. `migration-checkout-gst.sql` only if you need the legacy GST columns; it is additive and safe before the checkout migration.
   3. `migration-orders-and-checkout.sql`
   4. `migration-coupons.sql`
   5. `migration-newsletter.sql` and `migration-product-gallery.sql` if those features are needed and have not already been installed.
2. Confirm the SQL editor reports success. The checkout migration adds order ownership, tracking, payment reconciliation, and refund-review routines. The coupon migration adds coupon storage, redemption limits, free-delivery codes, and the coupon-aware checkout routine. The checkout migration already adds the GST columns, so the legacy compatibility migration is usually unnecessary. Do not apply it afterward as a way to update checkout logic; it does not install or replace the checkout routines.
3. In Vercel Production environment variables, set `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (or the legacy `SUPABASE_SERVICE_ROLE_KEY`), `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, and `CRON_SECRET`. Never put these secrets in browser code, Git, or chat.
4. Apply `migration-fixes.sql` last. It repairs capture recovery, adds the COD cash-collected action, disables direct browser updates to orders, and enables scheduled rate-limit cleanup. Reapply it after any future checkout SQL changes.
5. `migration-fixes.sql` assigns the `store_role=admin` app-metadata role to the existing confirmed owner account (`mishalmj03@gmail.com`). After applying the migration, sign out and back in so Supabase issues a fresh token. Admin API and RLS checks then use that trusted role and still require a confirmed email.
6. Use the same private `CRON_SECRET` in Vercel and the GitHub repository's **Settings → Secrets and variables → Actions → New repository secret**. The scheduled GitHub Action calls `/api/cron-reconcile` every 15 minutes; `workflow_dispatch` allows a manual run.
7. In Razorpay, make the webhook URL `https://lincydesigns.vercel.app/api/razorpay-webhook`, use the configured webhook secret, and subscribe to `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`, and `refund.failed`.
8. Post-payment receipts are handled by the Razorpay account setting. The store already sends the signed-in customer's name, email and mobile number to Checkout and uses its unique order number as Razorpay's receipt reference. Verify the enabled receipt notifications with a Razorpay test payment; do not add a second receipt sender in the store.
9. To pass Razorpay's configured convenience fee to the customer, have Razorpay activate the feature, select **Customer pays the fee**, and save it in Razorpay's Fee Bearer settings. Set `RAZORPAY_CUSTOMER_PAYS_FEE=true` in Vercel only after `migration-fixes.sql` is applied. Set `RAZORPAY_CUSTOMER_FEE_MAX_BPS` to the configured maximum fee in basis points (for example, `300` means 3%). Payments above this explicit cap are not marked paid. Do not add a separate percentage fee in the store; Razorpay displays its fee at checkout and returns it to the customer when a refund is initiated.
10. Confirm `https://lincydesigns.vercel.app` is the approved website in Razorpay. Use Razorpay test keys and test transactions before enabling live fees or taking a live order. Razorpay warns that changes to this fee model in test mode can also affect live mode. UPI app handoff also depends on the app being installed and the site being open in a supported browser.

## Deployment checks

- Vercel should use the repository root as the project root, `main` as Production Branch, and no build command for this static HTML/JavaScript project.
- After deployment, verify the storefront and `/admin` load, then run the GitHub Action manually and confirm it returns HTTP 200. The GitHub Action runs every 15 minutes; Vercel's daily cron is a backup. Hobby Vercel projects only permit daily Cron Jobs, so the more frequent trigger stays in GitHub Actions.
- Use Razorpay test keys and test mode to check a coupon, free-delivery coupon, COD order, online payment, order history, refund request, and the order in the admin page. Confirm Razorpay shows a captured payment and the database/admin record agrees before fulfillment. Do not test with a live payment.
- For a captured Razorpay payment, approve the request, enter the refund amount, then save it as Processed with the confirmation box checked. This submits one idempotent normal refund request to Razorpay; the webhook updates the final provider status. A COD cash refund must still be returned separately before recording it as Processed. Late or duplicate captures are flagged for review rather than silently discarded.

## Local checks

Run JavaScript syntax checks with `node --check` on `public/store.js`, `public/admin.js`, and each file under `api/` and `lib/`. Parse `vercel.json`, inspect the Actions workflow, and run `git diff --check` before publishing.
