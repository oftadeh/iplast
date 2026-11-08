import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Session, SessionGuard } from '../common/session';
import type { SessionClaims } from '../auth/auth.service';
import { OrderInput, OrdersService } from './orders.service';

@Controller('orders')
@UseGuards(SessionGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post() create(@Session() s: SessionClaims, @Body() body: OrderInput) { return this.orders.create(s.sub, body ?? {}); }
  @Get() mine(@Session() s: SessionClaims) { return this.orders.listMine(s.sub); }
  /** The customer accepts the final proforma, or asks the sales agent for a change. */
  @Post(':id/accept') accept(@Session() s: SessionClaims, @Param('id') id: string, @Body() b: { ok?: boolean; comment?: string }) { return this.orders.customerDecide(s.sub, id, b?.ok !== false, b?.comment); }
  @Get(':id/reorder') reorder(@Session() s: SessionClaims, @Param('id') id: string) { return this.orders.reorder(s.sub, id); }
  @Get(':id') one(@Session() s: SessionClaims, @Param('id') id: string) { return this.orders.get(s.sub, id, !!s.staff); }
}
