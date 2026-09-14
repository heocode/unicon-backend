// NestJS
import { Injectable } from '@nestjs/common';

@Injectable()
export class AuthenticationDeliveryRandomSourceService {
  randomUnit(): number {
    return Math.random();
  }
}
