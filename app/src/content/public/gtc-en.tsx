import { Link } from '@/i18n/navigation'

export function GtcEn() {
  return (
    <div lang="en">
      <p>
        These general terms and conditions (“Terms”) apply to the <strong>Excellence AI</strong>{' '}
        platform operated by <strong>Excellence Pay Kft.</strong> (“provider”) at{' '}
        <Link href="/">https://ai.excellencepay.com</Link>. Data processing is governed by the{' '}
        <Link href="/privacy">Privacy Policy</Link>.
      </p>

      <h2>1. The service</h2>
      <p>
        Excellence AI is a governed enterprise AI coworker platform. Invited members of the
        customer organization (tenant) can run AI agents, assign work, connect tools (for example
        Gmail or Google Drive), and — according to their permissions — approve sensitive actions.
        The platform is not a public consumer service that anyone can register for: access is by
        invitation.
      </p>

      <h2>2. Contract and account</h2>
      <ul>
        <li>The organization contracts with the provider under a separate order or subscription.</li>
        <li>
          By accepting the invitation and signing in, the user accepts these Terms and the Privacy
          Policy.
        </li>
        <li>
          The account is personal. Credentials must not be shared. The organization administrator
          may revoke access.
        </li>
      </ul>

      <h2>3. Acceptable use</h2>
      <p>The user and the organization are responsible for using Excellence AI lawfully. It is forbidden to:</p>
      <ul>
        <li>access other people&apos;s accounts or data without authorization,</li>
        <li>use the platform for abuse, unlawful content, or covert data extraction,</li>
        <li>use connected Google or other accounts without the owner&apos;s consent,</li>
        <li>circumvent security or permission limits.</li>
      </ul>
      <p>
        An AI agent&apos;s output is a suggestion. The organization is responsible for reviewing
        the output before taking a business, legal, or customer-facing step. Approval gates are
        part of the product; they do not replace the organization&apos;s own internal controls.
      </p>

      <h2>4. Connected accounts (Google and others)</h2>
      <p>
        Connecting a Google account, Gmail, or Drive is optional. Consent is given on the Google
        OAuth screen. The user may disconnect at any time in Excellence AI and in Google account
        permissions. The provider uses Google APIs under Google&apos;s terms and the Limited Use
        rules; details are in the <Link href="/privacy">Privacy Policy</Link>.
      </p>
      <p>
        Actions in a connected account are performed in the name of the user (and the
        organization). The agent works only with the permissions jointly allowed by the Google
        consent, the tenant policy, and the agent configuration.
      </p>

      <h2>5. Intellectual property</h2>
      <p>
        The Excellence AI software, trademarks, and documentation belong to the provider. The
        organization retains rights to its own data, documents, and content uploaded to the
        platform. The provider uses uploaded content only to provide the service.
      </p>

      <h2>6. Availability and liability</h2>
      <p>
        The platform is provided “as is”, with reasonable care. We do not warrant against language
        model errors, outages of external providers (Google, model APIs, authentication), or the
        business consequences of output the user approved. The provider&apos;s liability is limited
        to the fee paid by the organization for the relevant period, to the extent permitted by
        Hungarian law, except for intentional harm and liability that cannot be excluded by law.
      </p>

      <h2>7. Fees and termination</h2>
      <p>
        Fees are set in the order between the organization and the provider. The organization may
        terminate the subscription according to that contract. The provider may suspend access
        immediately if use is unlawful, fees are unpaid, or platform security is at risk. After
        termination, account and workspace data follow the retention rules in the Privacy Policy.
      </p>

      <h2>8. Governing law</h2>
      <p>
        These Terms are governed by Hungarian law. The parties submit to the Hungarian courts of
        competent jurisdiction if they cannot resolve a dispute by discussion.
      </p>

      <h2>9. Contact</h2>
      <p>
        Excellence Pay Kft. · Excellence AI
        <br />
        Website: <Link href="/">https://ai.excellencepay.com</Link>
        <br />
        Privacy: <a href="mailto:privacy@excellencepay.com">privacy@excellencepay.com</a>
      </p>
    </div>
  )
}
