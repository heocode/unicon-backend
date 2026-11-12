import { Injectable } from '@nestjs/common';

import { ResendMailHttpClient } from './resend-mail-http-client.service';

export type { ResendMailHttpResponse as ResendAuthenticationEmailTransportResponse } from './resend-mail-http-client.service';

// Legacy entry point until auth worker claim/defer integration in block 4.
@Injectable()
export class ResendAuthenticationEmailTransportService extends ResendMailHttpClient {}
