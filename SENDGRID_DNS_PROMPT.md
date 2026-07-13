# Lovable Prompt — Add SendGrid DNS Records

Can you add these DNS records to verify our SendGrid domain for email delivery?

The domain needs to be authenticated so we can send workspace invite emails and auth verification emails from SendGrid.

---

The domain to configure: **em3894.meetsensesyc.com**

Please add these 6 DNS records at the DNS provider:

| Type | Name / Host | Value / Target |
|------|------------|----------------|
| CNAME | `url9973.em3894.meetsensesyc.com` | `sendgrid.net` |
| CNAME | `110650609.em3894.meetsensesyc.com` | `sendgrid.net` |
| CNAME | `em4112.em3894.meetsensesyc.com` | `u110650609.wl110.sendgrid.net` |
| CNAME | `s1._domainkey.em3894.meetsensesyc.com` | `s1.domainkey.u110650609.wl110.sendgrid.net` |
| CNAME | `s2._domainkey.em3894.meetsensesyc.com` | `s2.domainkey.u110650609.wl110.sendgrid.net` |
| TXT | `_dmarc.em3894.meetsensesyc.com` | `v=DMARC1; p=none;` |

Once added, let me know so I can click **Verify** in SendGrid to complete the setup.

---

**Why this is needed:** Without these DNS records, SendGrid can't verify domain ownership and won't deliver any emails. This blocks:
- Workspace invite emails
- Password reset emails
- Email verification ("Confirm your signup") emails
- Any future transactional emails
