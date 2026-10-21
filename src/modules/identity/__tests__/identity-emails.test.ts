import { expect, test } from "bun:test";
import { type IdentityEmailPurpose, renderOTPEmail } from "../emails/otp";

const purposes: IdentityEmailPurpose[] = ["sign-in", "email-change", "deletion"];
const subject = "Your Zephium code is 012345";

for (const purpose of purposes) {
  test(`${purpose} email keeps the code available to autofill, copying, and plain-text clients`, () => {
    const email = renderOTPEmail("012345", purpose);
    expect(email.subject).toBe(subject);
    expect(email.text.split("\n")[0]).toBe(subject);
    expect(email.html).toContain(`<title>${subject}</title>`);
    const body = email.html.split(/<body\b[^>]*>/)[1];
    expect(
      body
        ?.replace(/<[^>]*>/g, "")
        .trimStart()
        .startsWith(`${subject}.`),
    ).toBe(true);
    expect(email.html).toMatch(/<p[^>]*dir="ltr"[^>]*>012345<\/p>/);
    expect(email.html).not.toContain("0 1 2 3 4 5");
    for (const content of [email.text, email.html]) {
      expect(content).toContain("expires in 5 minutes");
      expect(content).toContain("can be used only once");
      expect(content).toContain("Do not share this code with anyone");
      expect(content).toContain("Zephium will never ask you to send it by email");
      expect(content).toContain("Opening this email does not");
      expect(content).toContain("ignore this email");
    }
  });

  test(`${purpose} email is self-contained and uses accessible email layout with mobile and dark styles`, () => {
    const { html } = renderOTPEmail("012345", purpose);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="viewport"');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html.match(/<table\b/g)?.length).toBeGreaterThan(0);
    expect(html.match(/<table\b(?![^>]*role="presentation")/g)).toBeNull();
    expect(html).toContain("max-width:520px");
    expect(html).toContain("max-width: 540px");
    expect(html).toContain("prefers-color-scheme: dark");
    // No network resources, tracking pixels, action links, or executable content.
    expect(html).not.toMatch(/<(?:a|img|script|iframe|form|link|svg|video)\b/i);
    expect(html).not.toMatch(/\b(?:src|href|onclick)\s*=|@import|url\s*\(|https?:\/\//i);
  });
}

test("purpose copy explains the exact action in HTML and plain text", () => {
  const cases = [
    [
      "sign-in",
      "Sign in to Zephium",
      "sign in or finish creating your account",
      "Opening this email does not sign you in or create an account.",
    ],
    [
      "email-change",
      "Verify your new email",
      "verify your new email address and confirm the change",
      "Opening this email does not change your account email address.",
    ],
    [
      "deletion",
      "Confirm account deletion",
      "Entering this code in Zephium authorizes deletion of your Zephium account.",
      "Opening this email does not delete your account.",
    ],
  ] as const;
  for (const [purpose, title, instruction, viewing] of cases) {
    const email = renderOTPEmail("012345", purpose);
    for (const content of [email.text, email.html]) {
      expect(content).toContain(title);
      expect(content).toContain(instruction);
      expect(content).toContain(viewing);
    }
  }
  for (const purpose of ["email-change", "deletion"] as const) {
    const email = renderOTPEmail("012345", purpose);
    for (const content of [email.text, email.html]) {
      expect(content).toContain("do not enter the code");
      expect(content).not.toContain("finish creating your account");
    }
  }
});

test("omitted purpose preserves the sign-in mailer default", () => {
  expect(renderOTPEmail("000000")).toEqual(renderOTPEmail("000000", "sign-in"));
});

test("only six ASCII digits can enter the message and invalid inputs never appear in errors", () => {
  for (const otp of [
    "12345",
    "1234567",
    "123456\n",
    " 123456",
    "１２３４５６",
    "١٢٣٤٥٦",
    "12 456",
    "<img src=x onerror=alert(1)>",
    "12345&",
    null,
    123456,
  ]) {
    expect(() => renderOTPEmail(otp as string)).toThrow("Invalid identity email input");
  }
  for (const purpose of ["signup", "toString", "__proto__", "<script>", null, {}]) {
    expect(() => renderOTPEmail("012345", purpose as IdentityEmailPurpose)).toThrow(
      "Invalid identity email input",
    );
  }
  expect(renderOTPEmail("999999").subject).toBe("Your Zephium code is 999999");
});
