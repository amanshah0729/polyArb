require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Resend } = require('resend');

(async () => {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFICATION_EMAIL;
  if (!key) throw new Error('RESEND_API_KEY missing');
  if (!to) throw new Error('NOTIFICATION_EMAIL missing');

  const resend = new Resend(key);
  const { data, error } = await resend.emails.send({
    from: 'polyArb <onboarding@resend.dev>',
    to: [to],
    subject: 'Arb Detected – TEST (pipeline check)',
    text: [
      'This is a synthetic test email to verify the Resend pipeline.',
      '',
      'If you received this, the notifier deploy can actually deliver mail to your inbox.',
      `Sent at ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT`,
    ].join('\n'),
  });

  if (error) {
    console.error('Send failed:', error);
    process.exit(1);
  }
  console.log('Sent. Resend id:', data?.id ?? '(no id)');
})();
