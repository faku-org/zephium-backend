export type IdentityEmailPurpose = "sign-in" | "email-change" | "deletion";

const copy = {
  "sign-in": {
    label: "Account access",
    title: "Sign in to Zephium",
    instruction: "Enter this code in Zephium to sign in or finish creating your account.",
    viewing: "Opening this email does not sign you in or create an account.",
    unsolicited: "If you did not request this code, you can ignore this email.",
  },
  "email-change": {
    label: "Email verification",
    title: "Verify your new email",
    instruction:
      "Enter this code in Zephium to verify your new email address and confirm the change.",
    viewing: "Opening this email does not change your account email address.",
    unsolicited:
      "If you did not request an email change, do not enter the code. You can ignore this email.",
  },
  deletion: {
    label: "Account deletion",
    title: "Confirm account deletion",
    instruction: "Entering this code in Zephium authorizes deletion of your Zephium account.",
    viewing: "Opening this email does not delete your account.",
    unsolicited:
      "If you did not request account deletion, do not enter the code. You can ignore this email.",
  },
} as const;

/** Only the six validated ASCII digits are interpolated; account data never enters the HTML. */
export function renderOTPEmail(
  otp: string,
  purpose: IdentityEmailPurpose = "sign-in",
): { subject: string; text: string; html: string } {
  if (
    typeof otp !== "string" ||
    otp.length !== 6 ||
    !/^[0-9]{6}$/.test(otp) ||
    typeof purpose !== "string" ||
    !Object.hasOwn(copy, purpose)
  ) {
    // Do not expose the invalid value (potentially an OTP) in errors or logs.
    throw new TypeError("Invalid identity email input");
  }
  const message = copy[purpose];
  const subject = `Your Zephium code is ${otp}`;
  const expiry = "This code expires in 5 minutes and can be used only once.";
  const safety =
    "Do not share this code with anyone. Zephium will never ask you to send it by email.";
  return {
    subject,
    text: [
      subject,
      "",
      message.title,
      message.instruction,
      "",
      otp,
      "",
      expiry,
      safety,
      "",
      message.viewing,
      message.unsolicited,
      "",
      "Zephium",
    ].join("\n"),
    html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${subject}</title>
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    @media screen and (max-width: 540px) {
      .outer { padding: 24px 12px !important; }
      .content { padding: 28px 24px !important; }
      .heading { font-size: 26px !important; line-height: 32px !important; }
      .code { font-size: 34px !important; letter-spacing: 5px !important; }
    }
    @media (prefers-color-scheme: dark) {
      .background { background-color: #16151a !important; }
      .card { background-color: #222127 !important; border-color: #3c3944 !important; border-top-color: #a99af4 !important; }
      .primary { color: #f4f2f8 !important; }
      .secondary { color: #c8c3d1 !important; }
      .accent { color: #c3b5ff !important; }
      .code-box { background-color: #2e2b37 !important; border-color: #4c455f !important; }
      .divider { border-color: #3c3944 !important; }
    }
  </style>
</head>
<body class="background" style="margin:0; padding:0; width:100%; background-color:#f5f4f7; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">
  <div style="display:none; max-height:0; max-width:0; overflow:hidden; opacity:0; font-size:1px; line-height:1px; mso-hide:all;">${subject}. ${message.title}. Expires in 5 minutes.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="background" style="width:100%; background-color:#f5f4f7;">
    <tr>
      <td align="center" class="outer" style="padding:48px 16px;">
        <!--[if mso]><table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="width:100%; max-width:520px; background-color:#ffffff; border:1px solid #e5e2eb; border-top:3px solid #7860cf; border-radius:12px; border-spacing:0;">
          <tr>
            <td class="content" style="padding:36px 40px; font-family:Arial, Helvetica, sans-serif;">
              <p class="primary" style="margin:0 0 38px; color:#24212c; font-size:21px; line-height:28px; font-weight:700; letter-spacing:-0.5px;">Zephium</p>
              <p class="accent" style="margin:0 0 10px; color:#6d52b6; font-size:12px; line-height:18px; font-weight:700; letter-spacing:1px; text-transform:uppercase;">${message.label}</p>
              <h1 class="primary heading" style="margin:0 0 16px; color:#24212c; font-size:28px; line-height:35px; font-weight:700; letter-spacing:-0.6px;">${message.title}</h1>
              <p class="secondary" style="margin:0 0 24px; color:#5e586a; font-size:16px; line-height:25px;">${message.instruction}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
                <tr>
                  <td align="center" class="code-box" style="padding:22px 12px; background-color:#f4f1fc; border:1px solid #e5def7; border-radius:8px;">
                    <p class="primary code" dir="ltr" style="margin:0; color:#24212c; font-family:'Courier New', Courier, monospace; font-size:38px; line-height:48px; font-weight:700; letter-spacing:6px; white-space:nowrap;">${otp}</p>
                  </td>
                </tr>
              </table>
              <p class="secondary" style="margin:14px 0 24px; color:#5e586a; font-size:14px; line-height:22px;">${expiry}</p>
              <p class="primary" style="margin:0 0 24px; color:#24212c; font-size:14px; line-height:22px;">${safety}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
                <tr><td class="divider" style="border-top:1px solid #e5e2eb; font-size:0; line-height:0; height:24px;">&nbsp;</td></tr>
              </table>
              <p class="secondary" style="margin:0 0 10px; color:#5e586a; font-size:13px; line-height:21px;">${message.viewing}</p>
              <p class="secondary" style="margin:0; color:#5e586a; font-size:13px; line-height:21px;">${message.unsolicited}</p>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
        <p class="secondary" style="margin:20px 0 0; color:#5e586a; font-family:Arial, Helvetica, sans-serif; font-size:12px; line-height:18px;">Zephium · Account security</p>
      </td>
    </tr>
  </table>
</body>
</html>`,
  };
}
