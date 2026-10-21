import { expect, test } from "bun:test";
import { type IdentityEmailPurpose, otpEmailLogo, renderOTPEmail } from "../emails/otp";

const purposes: IdentityEmailPurpose[] = ["sign-in", "email-change", "deletion"];
const subject = "Your Zephium code is 012345";
const occurrences = (content: string, part: string) => content.split(part).length - 1;
const collapse = (content: string) => content.replace(/\s+/g, " ");
const visibleText = (html: string) =>
  collapse((html.split(/<body\b[^>]*>/)[1] ?? "").replace(/<[^>]*>/g, " "));

for (const purpose of purposes) {
  test(`${purpose} email keeps the code available to autofill, copying, and plain-text clients`, () => {
    const email = renderOTPEmail("012345", purpose);
    expect(email.subject).toBe(subject);
    expect(email.text.split("\n")[0]).toBe(subject);
    expect(email.html).toContain(`<title>${subject}</title>`);
    expect(visibleText(email.html).trimStart().startsWith(`${subject}.`)).toBe(true);
    // One contiguous, selectable text run; elsewhere only the title and preview text carry it.
    expect(email.html).toMatch(/<p[^>]*dir="ltr"[^>]*>012345<\/p>/);
    expect(occurrences(email.html, "012345")).toBe(3);
    expect(email.text.split("\n").filter((line) => line === "012345")).toHaveLength(1);
    for (const content of [email.text, email.html]) {
      expect(occurrences(content, "Expires in 5 minutes and can be used only once.")).toBe(1);
      expect(occurrences(content, "Zephium will never ask you to share it.")).toBe(1);
    }
  });

  test(`${purpose} email is self-contained and loads nothing remote`, () => {
    const { html } = renderOTPEmail("012345", purpose);
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain('<meta name="viewport"');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html.match(/<table\b(?![^>]*role="presentation")/g)).toBeNull();
    expect(html).not.toMatch(/<(?:a|script|iframe|form|link|svg|video|object|embed|base)\b/i);
    expect(html).not.toMatch(/\b(?:href|on[a-z]+)\s*=|@import|url\s*\(|https?:|\/\//i);
    // The only image is the inline mark, referenced by content ID, never by URL.
    expect(html.match(/<img\b[^>]*>/g)).toEqual([
      expect.stringContaining(`src="cid:${otpEmailLogo.content_id}"`),
    ]);
    expect(html.match(/\bsrc\s*=/g)).toHaveLength(1);
  });

  test(`${purpose} email reads correctly with images blocked, on narrow screens and in dark mode`, () => {
    const { html } = renderOTPEmail("012345", purpose);
    const img = html.match(/<img\b[^>]*>/)?.[0] ?? "";
    expect(img).toContain('alt=""');
    expect(img).toContain('width="28" height="28"');
    // The wordmark is live text beside the mark, so the brand survives blocked images.
    expect(visibleText(html)).toContain(" Zephium ");
    expect(html).toContain("max-width:480px");
    expect(html).toContain("@media screen and (max-width: 520px)");
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('<meta name="supported-color-schemes" content="light dark">');
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain("[data-ogsc] .z-text");
    expect(html).toContain("[data-ogsb] .z-ground");
    // Every inked or filled element has a dark-mode class, so no dark text lands on dark.
    for (const element of html.match(/<[a-z0-9]+\b[^>]*(?<![-\w])color:[^>]*>/g) ?? []) {
      expect(element).toMatch(/class="[^"]*\bz-(?:text|secondary|tertiary)\b/);
    }
    for (const element of html.match(/<[a-z0-9]+\b[^>]*background-color:[^>]*>/g) ?? []) {
      expect(element).toMatch(/class="[^"]*\bz-(?:ground|plate)\b/);
    }
  });
}

test("purpose copy states the action plainly and matches between HTML and plain text", () => {
  const cases = {
    "sign-in": [
      "Sign in to Zephium",
      "Enter this code in Zephium to sign in or finish creating your account.",
      "If you didn’t request this code, you can ignore this email.",
    ],
    "email-change": [
      "Verify your new email",
      "Enter this code in Zephium to verify your new email address and confirm the change.",
      "If you didn’t ask to use this address with Zephium, you can ignore this email.",
    ],
    deletion: [
      "Delete your account",
      "Enter this code in Zephium to permanently delete your account.",
      "This ends any paid plan, removes your remaining credits and signs out every device. It can’t be undone.",
      "Didn’t request this? Don’t enter the code",
    ],
  } as const;
  for (const purpose of purposes) {
    const email = renderOTPEmail("012345", purpose);
    for (const line of cases[purpose]) {
      expect(occurrences(email.text, line)).toBe(1);
      expect(occurrences(email.html, line)).toBe(1);
    }
    // The HTML shows every sentence the plain text carries.
    const body = visibleText(email.html);
    for (const line of email.text.split("\n").slice(2)) {
      if (line) expect(body).toContain(collapse(line));
    }
  }
  expect(renderOTPEmail("012345", "sign-in").text).not.toContain("delete");
  expect(renderOTPEmail("012345", "email-change").text).not.toContain("creating your account");
});

test("the inline mark is a small pre-sized PNG with Resend's REST attachment fields", () => {
  expect(Object.keys(otpEmailLogo).sort()).toEqual([
    "content",
    "content_id",
    "content_type",
    "filename",
  ]);
  expect(otpEmailLogo.content_type).toBe("image/png");
  const png = Buffer.from(otpEmailLogo.content, "base64");
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([84, 84]);
  expect(png.length).toBeLessThan(16 * 1024);
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
