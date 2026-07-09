import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator';

@Controller()
export class AppController {
  @Public()
  @Get('health')
  getHealth() {
    return { status: 'healthy', timestamp: new Date().toISOString() };
  }
}
