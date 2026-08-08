export class MailDeliveryError extends Error {
  constructor(message = 'Failed to send email.') {
    super(message);

    this.name = MailDeliveryError.name;
  }
}
