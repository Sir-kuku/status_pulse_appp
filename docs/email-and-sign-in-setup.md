# Connect real email and social sign-in

The app is ready for Resend email, Google sign-in and GitHub sign-in. These features need accounts and credentials that belong to you. Until you connect them, manual registration and sign-in work, email actions explain that delivery is unavailable, and unconfigured social buttons stay hidden. The app never substitutes simulated email in production.

Your current website is **https://status-pulse-appp.onrender.com**. Keep this exact address in `PUBLIC_BASE_URL` on Render. If you move to a custom domain later, update that value and both providers' callback URLs together.

## 1. Connect a sending domain and Resend

You need a domain whose DNS settings you control. The shared `onrender.com` domain belongs to Render, so you cannot verify it as your own email sending domain. Your website may keep its Render address while email comes from your own domain.

1. Create a [Resend account](https://resend.com/signup).
2. In **Domains**, add your sending domain or a dedicated subdomain. Add the DNS records Resend gives you, then wait for verification. Use the actual values shown in your account. Resend explains its SPF/DKIM setup in the [domain guide](https://resend.com/docs/dashboard/domains/introduction).
3. Create an API key with sending access for that domain. Choose an address such as `notifications@your-domain.com`. The example is a placeholder; use your verified domain.
4. Open the Status Pulse web service in Render, then **Environment**. Add the following values. Add the same email settings to the monitoring worker, if you have deployed it.

| Variable | Value |
| --- | --- |
| `PUBLIC_BASE_URL` | `https://status-pulse-appp.onrender.com` |
| `EMAIL_MODE` | `resend` |
| `EMAIL_FROM` | `Status Pulse <notifications@YOUR_VERIFIED_DOMAIN>` |
| `RESEND_API_KEY` | Your private Resend sending key |

Choose **Save, rebuild, and deploy** after setting the variables. Render documents that action in its [environment settings guide](https://render.com/docs/configure-environment-variables). Never put the real key in GitHub, a screenshot, or a chat message. Leave optional credential variables absent until you have their real values.

Account verification, password resets, password-change notices, team invitations, public subscription verification and incident updates all use this provider. The API process drains the email queue as well as the worker, so account emails can send without waiting for a monitoring tick. Continuous monitoring still requires the worker. A sleeping free web service cannot process background work while asleep.

## 2. Enable Google sign-in

In [Google Cloud Console](https://console.cloud.google.com/), create or select a project and configure Google Auth Platform with your app name, audience and contact details. Create an OAuth client of type **Web application**. Add this exact authorized redirect URI:

```text
https://status-pulse-appp.onrender.com/api/auth/oauth/google/callback
```

Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to the Render web service's environment, then redeploy. The Google button appears automatically when both settings exist. The app asks for basic identity scopes: `openid email profile`; it does not request access to users' Gmail inboxes. For testing, add the accounts allowed by your Google project's audience settings. Follow Google's production publishing requirements before opening sign-in to everyone. See Google's [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).

For local development, use a separate client or register `http://localhost:3000/api/auth/oauth/google/callback`, and keep local `PUBLIC_BASE_URL=http://localhost:3000`.

## 3. Enable GitHub sign-in

In GitHub, open **Settings → Developer settings → OAuth Apps → New OAuth App**. Use your website as the homepage and this callback URL:

```text
https://status-pulse-appp.onrender.com/api/auth/oauth/github/callback
```

Add `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` to the Render web service, then redeploy. This option is useful for the developers and operations teams who use Status Pulse. The app reads basic profile information and a verified email address; it does not request repository access. See GitHub's [OAuth app guide](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).

Existing manual accounts are not silently merged with a social identity. Sign in with the existing password, click your name at the bottom of the sidebar to open **Your account**, and connect the provider with the same email address. Future visits can use that provider. New users can create their account directly through Google or GitHub.

## 4. Check the complete experience

After Render finishes deploying:

1. Open `/api/auth/options`. It should report email mode `resend` and list the providers you configured. It never returns keys or secrets.
2. Create an account with an address you control. Open the verification email and verify your address. Existing accounts can request verification from **Your account**.
3. Invite a teammate from **Team**. The sender must have a verified email. The recipient opens the email, signs in or registers with the invited address, and accepts the invitation. Old invitations created before real email was enabled must be reissued.
4. Open **Email activity** to inspect queued, retrying, sent or failed messages. **Sent** means the provider accepted the message; it does not guarantee it reached the inbox. Check Resend's dashboard for delivery/bounce information and the recipient's spam folder if necessary.
5. Try **Forgot password?**. The email contains a one-use link valid for one hour. Resetting a password signs out existing sessions and sends a confirmation notice.
6. Test Google and GitHub using accounts with verified email addresses. Confirm returning users reach the same workspace.
7. Subscribe to a public status page, verify through the email, then post a public incident update. Follow the unsubscribe link to stop future notifications.

No live email or provider login has been verified until these steps are completed with your credentials. Automated tests use controlled provider responses and an isolated database.

## Your name and appearance

The footer reads **Designed & built by Sir. Kuku** and links to `https://github.com/Sir-kuku`. Set `CREATOR_NAME` and `CREATOR_URL` on the web service to change it. The link must use HTTPS.

Visitors can choose light, dark or system appearance. Their choice is saved in their browser and applies to account screens, the dashboard, public status pages and API documentation. Password eye buttons show or hide the field without submitting the form.

## What to check when something does not arrive

| What you see | What to check |
| --- | --- |
| Email unavailable | `EMAIL_MODE`, `EMAIL_FROM` and `RESEND_API_KEY` on the running service |
| Failed email, provider HTTP 401/403 | The API key, its sending permissions and the verified domain |
| Retrying email, provider HTTP 429 | Provider sending limits; the queue retries with a delay |
| Sent email but no inbox message | Recipient spelling, spam folder and Resend's delivery logs |
| Invitation requests verification | Verify your own account first, then send the invitation again |
| Old link is invalid | Request a new link; links expire, can be used once and may be superseded |
| Google redirect mismatch | Callback URL must exactly match Google Console and `PUBLIC_BASE_URL` |
| Social button missing | Both the client ID and secret must exist for that provider |
| Provider says the account exists | Sign in manually, click your name in the sidebar and connect that provider |

Payments remain an explicitly labelled demonstration. Email configuration does not turn on real billing. Local `EMAIL_MODE=simulation` exists only for the original assignment demonstrations and isolated tests; production rejects it.
