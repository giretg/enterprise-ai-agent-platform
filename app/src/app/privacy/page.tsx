import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPage } from '@/components/public-site/public-site-shell'

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'Privacy Policy for Excellence AI. How Excellence Pay Kft. accesses, collects, uses, stores, shares, protects, retains, and deletes personal data, including Google user data from Gmail and Google Drive.',
  robots: { index: true, follow: true },
  alternates: { canonical: 'https://ai.excellencepay.com/privacy' },
}

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      description="This Privacy Policy explains how Excellence AI accesses, collects, uses, stores, shares, protects, retains, and deletes personal data — including Google user data from Gmail and Google Drive."
      updated="14 September 2026"
    >
      <div lang="en">
        <p>
          This is the Privacy Policy for <strong>Excellence AI</strong>, a governed enterprise AI
          coworker platform operated by <strong>Excellence Pay Kft.</strong> (“Excellence Pay”,
          “we”, “us”) at <Link href="/">https://ai.excellencepay.com</Link>. It is a dedicated
          privacy policy page, not a homepage summary. Terms of service:{' '}
          <Link href="/gtc">https://ai.excellencepay.com/gtc</Link>.
        </p>
        <p>
          Privacy contact:{' '}
          <a href="mailto:privacy@excellencepay.com">privacy@excellencepay.com</a>.
        </p>
        <p>
          This notice is written for Google OAuth / Google API Services verification and for GDPR.
          It discloses how the application accesses, uses, stores, and shares Google user data.
        </p>

        <h2>1. Who we are</h2>
        <p>
          Data controller: <strong>Excellence Pay Kft.</strong>, operator of the Excellence AI
          service at https://ai.excellencepay.com. Excellence AI is an invitation-only signed-in
          workspace. It is not a public consumer chatbot and is not directed at children.
        </p>
        <p>
          Privacy inquiries, access requests, and deletion requests:{' '}
          <a href="mailto:privacy@excellencepay.com">privacy@excellencepay.com</a>.
        </p>

        <h2>2. Personal data we collect (other than Google APIs)</h2>
        <p>When you use or interact with Excellence AI, we may collect or process:</p>
        <ul>
          <li>
            <strong>Account and identity:</strong> name, email address, organization (tenant)
            membership, role, and sign-in events. Authentication is performed by Clerk.
          </li>
          <li>
            <strong>Workspace content:</strong> conversations with AI agents, tickets, uploaded
            files, approvals, playbooks, knowledge-base documents, cost budgets, and audit logs.
            These belong to the customer organization and are isolated per tenant.
          </li>
          <li>
            <strong>Device and security data:</strong> IP address, user-agent, timestamps, and
            similar technical logs used for authentication, abuse prevention, and incident
            investigation. We do not use advertising identifiers.
          </li>
          <li>
            <strong>Cookies:</strong> essential session cookies for sign-in (Clerk) and application
            security. We do not use advertising cookies, retargeting pixels, or independent
            analytics SDKs on this service.
          </li>
        </ul>

        <h2>3. What Google user data is accessed by this application</h2>
        <p>
          Connecting a Google account is <strong>optional</strong>. Excellence AI does not require
          Google Sign-In to enter the workspace. We request Google OAuth access only when a
          signed-in user (or a function enabled for that user by their tenant administrator)
          wants Gmail or Google Drive features.
        </p>
        <p>
          With the user&apos;s OAuth consent, and only for the scopes the user grants, Excellence
          AI may access the following Google user data:
        </p>
        <ul>
          <li>
            <strong>Google account profile identifiers:</strong> email address and basic profile
            identifiers (for example via <code>openid</code>,{' '}
            <code>https://www.googleapis.com/auth/userinfo.email</code>,{' '}
            <code>https://www.googleapis.com/auth/userinfo.profile</code>) so we can label the
            connected account and bind the token to the signed-in user.
          </li>
          <li>
            <strong>Gmail:</strong> message content, headers, labels, drafts, and send/modify
            actions as granted. Typical scopes include{' '}
            <code>https://www.googleapis.com/auth/gmail.readonly</code>,{' '}
            <code>https://www.googleapis.com/auth/gmail.compose</code>,{' '}
            <code>https://www.googleapis.com/auth/gmail.send</code>, and{' '}
            <code>https://www.googleapis.com/auth/gmail.modify</code>. We use these only to search,
            read, draft, send, or label email that the user asked an agent to handle.
          </li>
          <li>
            <strong>Google Drive:</strong> file and folder metadata and content as granted. Typical
            scopes include <code>https://www.googleapis.com/auth/drive.readonly</code>,{' '}
            <code>https://www.googleapis.com/auth/drive.file</code>, and — only if a tenant
            administrator enables it — <code>https://www.googleapis.com/auth/drive</code>. We use
            these to list, search, read, create, update, move, copy, trash, restore, or share
            files that the user requested.
          </li>
        </ul>
        <p>
          We do not request Domain-wide Delegation. We do not access a Google account without the
          user&apos;s OAuth consent. We request only the scopes needed for the feature the user is
          connecting.
        </p>

        <h2>4. How this application uses Google user data</h2>
        <p>
          We will use Google user data solely to provide the user-facing services the user
          requested in Excellence AI. Examples:
        </p>
        <ul>
          <li>summarize or search Gmail threads the user asked an agent to work on;</li>
          <li>draft or send a reply from the connected Gmail account after the configured approval;</li>
          <li>read a Google Drive document so the agent can answer a question or prepare a draft;</li>
          <li>create or update a Drive file the user asked the agent to write.</li>
        </ul>
        <p>Google user data is also used, where necessary, to:</p>
        <ul>
          <li>enforce access control, tenant isolation, and human-approval gates;</li>
          <li>keep an audit trail of agent runs for the customer organization;</li>
          <li>operate, secure, debug, and support the service.</li>
        </ul>
        <p>
          We will <strong>not</strong> sell Google user data. We will <strong>not</strong> use
          Google user data for targeted advertising, personalized ads, retargeting, interest-based
          advertising, credit-worthiness, lending, or independent user profiling. We will{' '}
          <strong>not</strong> use Google Workspace API data to develop, improve, or train
          generalized or non-personalized AI / ML models.
        </p>

        <h2>5. How this application stores Google user data</h2>
        <p>
          OAuth access tokens and refresh tokens are stored encrypted in a server-side token vault
          (Google Cloud Secret Manager in production), bound to the user, tenant, and connector
          grant. Tokens are not stored in the browser, in prompts, or in application logs.
        </p>
        <p>
          Gmail message bodies and Drive file contents are processed to perform the requested
          task. They may appear in that tenant&apos;s conversation, ticket, or audit trail so the
          organization can review the agent&apos;s work. We do not keep a wholesale secondary
          archive of the user&apos;s Gmail mailbox or Google Drive.
        </p>
        <p>
          Account and workspace data are stored in the European Union or on infrastructure that is
          contractually protected by the operator. Data in transit uses TLS. Data at rest on our
          hosting and database processors is encrypted by those processors&apos; standard
          controls.
        </p>

        <h2>6. How we share, transfer, or disclose Google user data</h2>
        <p>
          We do not transfer or disclose Google user data to third parties for purposes other than
          providing or improving the user-facing features of Excellence AI, except as required by
          law or for security investigations.
        </p>
        <p>Recipients that may receive relevant data to complete a requested task:</p>
        <ul>
          <li>
            <strong>Large-language-model providers configured for the tenant</strong> (for example
            OpenAI, Anthropic, Google, or xAI): the prompt text and attached content needed for
            that run. A privacy gateway can tokenize or block sensitive fields (for example names,
            emails, phone numbers, secrets) before egress, according to tenant policy.
          </li>
          <li>
            <strong>Clerk</strong> — authentication and session management for the Excellence AI
            account (not the Google mailbox itself).
          </li>
          <li>
            <strong>Google Cloud / Firebase App Hosting and database processors</strong> —
            hosting, encrypted storage, and operational infrastructure acting as subprocessors.
          </li>
          <li>
            <strong>The customer organization</strong> — tenant administrators and authorized
            coworkers can see workspace conversations, approvals, and audit logs for their own
            tenant. Other tenants cannot.
          </li>
        </ul>
        <p>
          We do not sell Google user data to data brokers or information resellers. We do not
          transfer Google user data to advertising platforms. Human access to Google user data by
          Excellence Pay staff is limited to security, abuse investigation, legal obligation, or
          support the user or tenant administrator requested.
        </p>

        <h2>7. Data protection mechanisms</h2>
        <p>Security procedures are in place to protect the confidentiality of your data:</p>
        <ul>
          <li>TLS encryption in transit for the application and Google API calls;</li>
          <li>encrypted storage of OAuth access and refresh tokens in a server-side vault;</li>
          <li>tenant isolation so one organization cannot read another organization&apos;s data;</li>
          <li>
            access control, role-based permissions, and human approval gates before sensitive
            outbound actions (for example sending email or sharing a Drive file);
          </li>
          <li>
            a privacy gateway that can pseudonymize or block sensitive fields before content is
            sent to an external model;
          </li>
          <li>audit logging of agent runs, connector use, and administrative changes;</li>
          <li>no Domain-wide Delegation and no service-account impersonation of end users.</li>
        </ul>

        <h2>8. Data retention and deletion</h2>
        <p>
          We retain personal information for the length of time needed to fulfill the purposes in
          this Privacy Policy, unless a longer period is required or permitted by law. When the
          retention period expires for a given type of data, we delete or anonymize it.
        </p>
        <ul>
          <li>
            <strong>Google OAuth tokens:</strong> retained only while the Google connection is
            active. If you disconnect Google in Excellence AI account settings, we delete the
            stored tokens and stop further Google API calls.
          </li>
          <li>
            <strong>Revoke at Google:</strong> you may also revoke Excellence AI at{' '}
            <a href="https://myaccount.google.com/permissions">
              https://myaccount.google.com/permissions
            </a>
            .
          </li>
          <li>
            <strong>Workspace content:</strong> retained for the life of the customer contract, then
            deleted or anonymized according to the contract and legal retention duties.
          </li>
          <li>
            <strong>Audit logs:</strong> may be kept for the contractual security-retention period,
            then deleted or aggregated.
          </li>
        </ul>
        <p>
          You may request that your data be deleted by writing to{' '}
          <a href="mailto:privacy@excellencepay.com">privacy@excellencepay.com</a> or by asking
          your tenant administrator. We will honor deletion requests subject to legal and
          security-retention limits.
        </p>

        <h2>9. Limited Use of Google user data</h2>
        <p>
          Excellence AI&apos;s use of information received from Google APIs adheres to the{' '}
          <a href="https://developers.google.com/terms/api-services-user-data-policy">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
        <p>
          Google Workspace API data is used only to provide or improve user-facing features that
          are prominent in Excellence AI. We do not transfer Google user data except to provide
          those features with the user&apos;s consent, for security, to comply with law, or as part
          of a merger or sale after obtaining explicit prior consent. We do not use Google
          Workspace APIs to develop, improve, or train non-personalized AI and/or ML models.
        </p>

        <h2>10. Legal basis and your rights</h2>
        <p>
          Depending on the processing, our legal bases are performance of a contract (providing
          the service), legitimate interests (security, audit, abuse prevention), and — for Google
          API access — your consent, which you may withdraw at any time by disconnecting the
          Google account.
        </p>
        <p>
          You may request access, rectification, erasure, restriction, portability, and you may
          object to processing based on legitimate interests. You may lodge a complaint with the
          Hungarian National Authority for Data Protection and Freedom of Information (NAIH).
          Contact: <a href="mailto:privacy@excellencepay.com">privacy@excellencepay.com</a>.
        </p>

        <h2>11. Children</h2>
        <p>
          Excellence AI is a business workspace for invited adult members of customer
          organizations. It is not directed at children under 16, and we do not knowingly collect
          Google user data from children.
        </p>

        <h2>12. Changes</h2>
        <p>
          If we change how Excellence AI uses Google user data, we will update this Privacy Policy
          and notify users as required, including prompting for consent before we use Google user
          data in a new way.
        </p>
      </div>

      <h2>Magyar összefoglaló</h2>
      <p>
        Az <strong>Excellence AI</strong> szolgáltatást az <strong>Excellence Pay Kft.</strong>{' '}
        üzemelteti a <Link href="/">https://ai.excellencepay.com</Link> címen. Ez a dokumentum a
        GDPR és a Google API Services User Data Policy szerinti tájékoztatás. ÁSZF:{' '}
        <Link href="/gtc">https://ai.excellencepay.com/gtc</Link>. Megkeresés:{' '}
        <a href="mailto:privacy@excellencepay.com">privacy@excellencepay.com</a>.
      </p>
      <h3>Milyen adatokat kezelünk</h3>
      <p>
        Meghívásos belépéskor kezeljük a nevedet, e-mail-címedet, a szervezeti tagságodat, a
        szerepkörödet és a belépési eseményeket. A beléptetést a Clerk végzi. Kezeljük a
        beszélgetéseket, feladatokat, feltöltött fájlokat, jóváhagyásokat, auditnaplókat és a
        költségkereteket, tenantonként elkülönítve.
      </p>
      <h3>Google-felhasználói adatok</h3>
      <p>
        A Google-fiók csatlakoztatása nem kötelező. Csak akkor kérünk hozzáférést, ha Gmailt vagy
        Google Drive-ot akarsz az ügynöknek adni. A hozzájárulásoddal hozzáférhetünk a
        profilazonosítóhoz, a Gmail-üzenetekhez (olvasás, piszkozat, küldés, címkézés) és a
        Drive-fájlokhoz (listázás, olvasás, létrehozás, módosítás, áthelyezés, megosztás) a
        megadott scope szerint. Nem kérünk Domain-wide Delegation-t.
      </p>
      <h3>Mire használjuk, kivel osztjuk meg</h3>
      <p>
        Az adatokat a kért, a termékben látható funkcióhoz használjuk: beléptetés, ügynökfuttatás,
        audit, biztonság, üzemeltetés. Nyelvi modell szolgáltatója (tenant szerint például OpenAI,
        Anthropic, Google, xAI), Clerk, Google Cloud / Firebase App Hosting és a saját szervezeted
        jogosult tagjai kaphatják a feladathoz szükséges adatot. Nem értékesítjük, nem adjuk
        reklámra, és nem tanítunk belőle általános AI/ML modellt (Limited Use).
      </p>
      <h3>Tárolás, védelem, törlés</h3>
      <p>
        A Google-tokenek titkosított szerveroldali tárolóban vannak. Az adat úton TLS-sel védett.
        A kapcsolatot a fiókbeállításokban bármikor bonthatod; ekkor a tokeneket töröljük. Google
        oldalon is visszavonható:{' '}
        <a href="https://myaccount.google.com/permissions">https://myaccount.google.com/permissions</a>
        . Törlési kérés: <a href="mailto:privacy@excellencepay.com">privacy@excellencepay.com</a>.
      </p>
    </LegalPage>
  )
}
