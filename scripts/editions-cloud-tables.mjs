// §4.1 ownership matrix — the single source of truth for the cloud-table
// contract (#886). Each entry pairs a pg table name (consumed by
// check-migration-ownership.mjs: which journal may create/alter it) with its
// `@manyfold/db` export name (denied to core files by eslint.config.js: after
// the journal split an OSS database does not have these tables). Adding a
// table here extends BOTH guards at once; an entry missing either name is a
// contract error the ownership test rejects.
export const CLOUD_TABLE_CONTRACT = [
    { table: 'payments', dbExport: 'payments' },
    { table: 'payment_adjustments', dbExport: 'paymentAdjustments' },
    { table: 'plan_subscriptions', dbExport: 'planSubscriptions' },
    { table: 'subscription_invoices', dbExport: 'subscriptionInvoices' },
    { table: 'stripe_events', dbExport: 'stripeEvents' },
    { table: 'challenge_campaigns', dbExport: 'challengeCampaigns' },
    { table: 'challenge_registrations', dbExport: 'challengeRegistrations' },
    { table: 'challenge_submissions', dbExport: 'challengeSubmissions' },
    { table: 'waitlist_signups', dbExport: 'waitlistSignups' },
    { table: 'waitlist_invites', dbExport: 'waitlistInvites' },
    { table: 'acquisition_campaigns', dbExport: 'acquisitionCampaigns' },
    { table: 'acquisition_channels', dbExport: 'acquisitionChannels' },
    { table: 'acquisition_conversions', dbExport: 'acquisitionConversions' },
    {
        table: 'acquisition_link_daily_stats',
        dbExport: 'acquisitionLinkDailyStats'
    },
    { table: 'acquisition_links', dbExport: 'acquisitionLinks' },
    {
        table: 'user_acquisition_attributions',
        dbExport: 'userAcquisitionAttributions'
    },
    { table: 'experiments', dbExport: 'experiments' },
    { table: 'experiment_overrides', dbExport: 'experimentOverrides' },
    { table: 'managed_channel_breakers', dbExport: 'managedChannelBreakers' },
    { table: 'managed_model_accounts', dbExport: 'managedModelAccounts' },
    { table: 'managed_model_catalog', dbExport: 'managedModelCatalog' },
    {
        table: 'managed_model_signup_credit_grants',
        dbExport: 'managedModelSignupCreditGrants'
    },
    { table: 'container_skus', dbExport: 'containerSkus' },
    { table: 'container_subscriptions', dbExport: 'containerSubscriptions' },
    // §4.2 expand tables (2026-08-18): the new homes for oauth-state touch
    // snapshots and plan pricing; the matching core-column contracts followed.
    { table: 'acquisition_oauth_touches', dbExport: 'acquisitionOauthTouches' },
    { table: 'plan_billing', dbExport: 'planBilling' },
    // §4.1 Phase-4 expand (2026-08-21): the new home for the Stripe customer
    // mapping on core users; the matching core-column contract follows.
    { table: 'stripe_customers', dbExport: 'stripeCustomers' },
    // ADR-0023 deletion tombstone (2026-08-22).
    {
        table: 'deleted_user_billing_refs',
        dbExport: 'deletedUserBillingRefs'
    },
    // First top-up offer (2026-09-04): promotional credit is a commercial
    // concept end to end — an OSS database has no campaigns to run and no
    // bonuses to grant.
    { table: 'credit_campaigns', dbExport: 'creditCampaigns' },
    { table: 'credit_grants', dbExport: 'creditGrants' },
    { table: 'offer_impressions', dbExport: 'offerImpressions' }
]

export const CLOUD_TABLE_DB_EXPORTS = CLOUD_TABLE_CONTRACT.map(
    (entry) => entry.dbExport
)
