import { readFileSync } from "node:fs";

export type IdentityEmailPurpose = "sign-in" | "email-change" | "deletion";

const copy = {
  "sign-in": {
    title: "Sign in to Zephium",
    lead: ["Enter this code in Zephium to sign in or finish creating your account."],
    unsolicited: "If you didn’t request this code, you can ignore this email.",
  },
  "email-change": {
    title: "Verify your new email",
    lead: ["Enter this code in Zephium to verify your new email address and confirm the change."],
    unsolicited: "If you didn’t ask to use this address with Zephium, you can ignore this email.",
  },
  deletion: {
    title: "Delete your account",
    lead: [
      "Enter this code in Zephium to permanently delete your account.",
      "This ends any paid plan, removes your remaining credits and signs out every device. It can’t be undone.",
    ],
    unsolicited:
      "Didn’t request this? Don’t enter the code, and sign out unfamiliar devices in Settings\u00a0→\u00a0Account.",
  },
} as const;

const expiry = "Expires in 5 minutes and can be used only once.";
const neverShare = "Zephium will never ask you to share it.";

/**
 * The mark travels with the message as an inline (CID) attachment, so it shows
 * when remote images are blocked and the email fetches nothing from a server.
 * Fields use Resend's REST names because the mailer posts JSON directly.
 */
export const otpEmailLogo = {
  filename: "zephium.png",
  content_type: "image/png",
  content_id: "zephium-mark",
  content: readFileSync(new URL("./zephium-mark.png", import.meta.url)).toString("base64"),
} as const;

const font =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const light = {
  ground: "#ffffff",
  plate: "#f3f3f5",
  rule: "#e9e9ec",
  text: "#1c1c1f",
  secondary: "#55555c",
  tertiary: "#75757c",
};
const dark = {
  ground: "#18181b",
  plate: "#242428",
  rule: "#2e2e33",
  text: "#f4f4f6",
  secondary: "#b1b1b7",
  tertiary: "#8c8c93",
};

// Outlook.com marks the elements it recolours with data-ogsb/data-ogsc; the
// same palette is pinned there so its automatic inversion cannot pick its own.
const darkRules = (background: string, color: string) =>
  `${background}.z-ground { background-color: ${dark.ground} !important; }
      ${background}.z-plate { background-color: ${dark.plate} !important; }
      ${background}.z-rule { border-top-color: ${dark.rule} !important; }
      ${color}.z-text { color: ${dark.text} !important; }
      ${color}.z-secondary { color: ${dark.secondary} !important; }
      ${color}.z-tertiary { color: ${dark.tertiary} !important; }`;

const paragraph = (className: keyof typeof light, size: 13 | 15, margin = "0") =>
  `class="z-${className}" style="margin:${margin}; font-family:${font}; font-size:${size}px; line-height:${size === 15 ? 24 : 20}px; color:${light[className]};"`;

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
  const footer = `${message.unsolicited} ${neverShare}`;
  const lead = message.lead
    .map((line, index) =>
      index === 0
        ? `<p ${paragraph("secondary", 15)}>${line}</p>`
        : `<p ${paragraph("text", 15, "12px 0 0")}>${line}</p>`,
    )
    .join("\n              ");
  return {
    subject,
    text: [
      subject,
      "",
      message.title,
      "",
      ...message.lead.flatMap((line) => [line, ""]),
      otp,
      "",
      expiry,
      "",
      footer,
      "",
      "Zephium",
    ].join("\n"),
    html: `<!doctype html>
<html lang="en" dir="ltr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${subject}</title>
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    body { margin: 0; padding: 0; }
    @media screen and (max-width: 520px) {
      .z-frame { padding: 40px 24px 56px !important; }
      .z-brand { padding-bottom: 40px !important; }
      .z-title { font-size: 22px !important; line-height: 28px !important; }
    }
  </style>
  <style>
    @media (prefers-color-scheme: dark) {
      ${darkRules("", "")}
    }
  </style>
  <style>
      ${darkRules("[data-ogsb] ", "[data-ogsc] ")}
  </style>
  <!--[if mso]><style>h1, p, td { font-family: 'Segoe UI', Arial, sans-serif !important; }</style><![endif]-->
</head>
<body class="z-ground" style="margin:0; padding:0; width:100%; background-color:${light.ground}; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">
  <div style="display:none; max-height:0; max-width:0; overflow:hidden; opacity:0; font-size:1px; line-height:1px; mso-hide:all;">${subject}. It expires in 5 minutes.${"&#8199;&#847;".repeat(24)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="z-ground" style="width:100%; background-color:${light.ground};">
    <tr>
      <td align="center" class="z-frame" style="padding:64px 24px 72px;">
        <!--[if mso]><table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:480px;">
          <tr>
            <td align="left" class="z-brand" style="padding:0 0 48px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:0 10px 0 0; vertical-align:middle;"><img src="cid:${otpEmailLogo.content_id}" width="28" height="28" alt="" style="display:block; width:28px; height:28px; border:0; outline:none;"></td>
                  <td class="z-text" style="vertical-align:middle; font-family:${font}; font-size:17px; line-height:28px; font-weight:600; letter-spacing:-0.3px; color:${light.text};">Zephium</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="left">
              <h1 class="z-text z-title" style="margin:0; font-family:${font}; font-size:24px; line-height:32px; font-weight:600; letter-spacing:-0.4px; color:${light.text};">${message.title}</h1>
            </td>
          </tr>
          <tr>
            <td align="left" style="padding:10px 0 0;">
              ${lead}
            </td>
          </tr>
          <tr>
            <td align="left" style="padding:28px 0 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="z-plate" style="padding:16px 18px 16px 24px; background-color:${light.plate}; border-radius:14px;">
                    <p class="z-text" dir="ltr" style="margin:0; font-family:${font}; font-size:40px; line-height:48px; font-weight:600; letter-spacing:6px; font-variant-numeric:tabular-nums; white-space:nowrap; color:${light.text};">${otp}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="left" style="padding:14px 0 0;">
              <p ${paragraph("secondary", 13)}>${expiry}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:44px 0 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
                <tr><td class="z-rule" style="height:1px; border-top:1px solid ${light.rule}; font-size:0; line-height:0;">&nbsp;</td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="left" style="padding:20px 0 0;">
              <p ${paragraph("tertiary", 13)}>${footer}</p>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`,
  };
}
