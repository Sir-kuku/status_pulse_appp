# Connect real email and social sign-in

The app is ready for Resend email, Google sign-in and GitHub sign-in. These features need accounts and credentials that belong to you. Until you connect them, manual registration and sign-in work, email actions explain that delivery is unavailable, and unconfigured social buttons stay hidden. Email defaults to disabled on both localhost and Render when no sender and key are configured. Simulated email requires an explicit local setting and is never allowed in production.

Your current website is **https://status-pulse-appp.onrender.com**. Keep this exact address in `PUBLIC_BASE_URL` on Render. If you move to a custom domain later, update that value and both providers' callback URLs together.

## Why localhost and Render can look different

The code is shared through GitHub, but configuration and data belong to each running environment. Localhost reads your local `.env`; Render reads its own **Environment** settings. `npm run local` also uses an isolated local database, so creating an account there does not create it on Render. Use the website where you created the account when requesting a password reset.

Your browser saves its light/dark/system choice separately for each website address. Choosing dark mode on localhost does not change the saved choice on Render. Select your preference on each site. An older running local process also needs restarting after configuration changes.

## 1. Send your first real email with Resend

You can test delivery to your own inbox before buying or connecting a domain. Resend allows `onboarding@resend.dev` to send only to the email address associated with your Resend account. Team invitations and notifications to other recipients need your own verified sending domain. See Resend's [testing sender restrictions](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).

1. Create a [Resend account](https://resend.com/signup) using the email address where you want to receive the first test.
2. Create an API key with sending access in the Resend dashboard.
3. Open the Status Pulse web service in Render, then **Environment**, and add these values:

| Variable | Value for your first inbox test |
| --- | --- |
| `PUBLIC_BASE_URL` | `https://status-pulse-appp.onrender.com` |
| `EMAIL_MODE` | `resend` |
| `EMAIL_FROM` | `Status Pulse <onboarding@resend.dev>` |
| `RESEND_API_KEY` | Your private Resend sending key |

4. Choose **Save, rebuild, and deploy**. When deployment finishes, open the Render website and create an account with the same email address used for Resend. If the account already exists, sign in and request verification from **Your account**, or use **Forgot password?** to test recovery.
5. Check that inbox and its spam folder, then check Resend's email log. The testing sender cannot deliver to a teammate's different address; a rejection in that case is an expected provider restriction.

Enter secrets directly in Render, never in GitHub, screenshots, or chat. If testing locally instead, put them in your untracked `.env`, keep `PUBLIC_BASE_URL=http://localhost:3000`, and restart the local server. Do not put the Render URL in local email settings unless the account and token were created on Render.

### Enable email for everyone

To send to teammates and customers, use a domain whose DNS settings you control. The shared `onrender.com` domain belongs to Render, so you cannot verify it as your own email sending domain. Your website may keep its Render address while email comes from your own domain.

1. In Resend **Domains**, add your domain or a dedicated sending subdomain.
2. Add the DNS records shown by Resend, then wait for verification. Use the actual values from your account; the [domain guide](https://resend.com/docs/dashboard/domains/introduction) explains SPF and DKIM.
3. Ensure your API key can send from that domain. Choose an address such as `notifications@your-domain.com`.
4. Replace the testing sender in Render with your verified sender. Configure the monitoring worker with the same email settings if you have deployed it.

| Variable | Value |
| --- | --- |
| `PUBLIC_BASE_URL` | `https://status-pulse-appp.onrender.com` |
| `EMAIL_MODE` | `resend` |
| `EMAIL_FROM` | `Status Pulse <notifications@YOUR_VERIFIED_DOMAIN>` |
| `RESEND_API_KEY` | Your private Resend sending key |

Choose **Save, rebuild, and deploy** after updating the variables. Render documents that action in its [environment settings guide](https://render.com/docs/configure-environment-variables). Leave optional credential variables absent until you have their real values.

Account verification, password resets, password-change notices, team invitations, public subscription verification and incident updates all use this provider. The API process drains the email queue as well as the worker, so account emails can send without waiting for a monitoring tick. Continuous monitoring still requires the worker. A sleeping free web service cannot process background work while asleep.

## 2. Enable Google sign-in

Google sign-in has its own configuration; connecting Resend does not enable it. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project, then open **Google Auth Platform**:

1. In **Branding**, enter the app name **Status Pulse**, your support email and developer contact details. Complete the required app information.
2. In **Audience**, choose **External** for a site intended for personal Google accounts and users outside your organization. While setting up the app, add your Google account and any intended testers under **Test users**. Follow the publishing requirements shown by Google before opening the app to everyone. Google's [consent setup guide](https://developers.google.com/workspace/guides/configure-oauth-consent) explains these settings.
3. In **Clients**, choose **Create client**, then **Web application**. Add this exact **Authorized redirect URI**:

```text
https://status-pulse-appp.onrender.com/api/auth/oauth/google/callback
```

4. Save the client and copy its client ID and secret directly into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the Render web service's **Environment** settings. Keep `PUBLIC_BASE_URL=https://status-pulse-appp.onrender.com`.
5. Save and redeploy the service. Refresh the sign-in page after the deployment completes. The Google button appears when both settings are configured; try it with an account you added for testing.

The app asks for basic identity scopes: `openid email profile`. It does not request access to Gmail inboxes. The redirect URI must match exactly, including HTTPS, hostname and callback path. See Google's [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).

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
| Resend testing sender rejects a teammate | `onboarding@resend.dev` only sends to your Resend account's email; verify your own domain for other recipients |
| Retrying email, provider HTTP 429 | Provider sending limits; the queue retries with a delay |
| Sent email but no inbox message | Recipient spelling, spam folder and Resend's delivery logs |
| Invitation requests verification | Verify your own account first, then send the invitation again |
| Old link is invalid | Request a new link; links expire, can be used once and may be superseded |
| Google redirect mismatch | Callback URL must exactly match Google Console and `PUBLIC_BASE_URL` |
| Social button missing | Both the client ID and secret must exist for that provider |
| Settings work locally but not on Render | Add them to Render's Environment settings, redeploy and refresh; local `.env` is not uploaded |
| Reset never arrives for a local account on Render | Use the environment where the account exists; the local database and hosted database are separate |
| Different theme on localhost and Render | Set the preference on both addresses; browser storage is separate for each origin |
| Provider says the account exists | Sign in manually, click your name in the sidebar and connect that provider |

Payments remain an explicitly labelled demonstration. Email configuration does not turn on real billing. Local `EMAIL_MODE=simulation` with `ENABLE_SIMULATIONS=true` exists only for the original assignment demonstrations and isolated tests; it never sends to an inbox, and production rejects it. Leaving email settings absent keeps email disabled in every environment.
