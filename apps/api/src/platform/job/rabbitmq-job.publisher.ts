import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { JobMessage, JobPublisher } from './job.ports';

type ConfirmChannel = {
  assertQueue(queue: string, options: { durable: boolean }): Promise<unknown>;
  sendToQueue(
    queue: string,
    content: Buffer,
    options: { persistent: boolean; contentType: string; messageId: string },
  ): boolean;
  waitForConfirms(): Promise<void>;
  close(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: () => void): void;
};
type AmqpConnection = {
  createConfirmChannel(): Promise<ConfirmChannel>;
  close(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: () => void): void;
};
type AmqpModule = { connect(url: string): Promise<AmqpConnection> };

@Injectable()
export class RabbitMqJobPublisher implements JobPublisher, OnModuleDestroy {
  private connection: AmqpConnection | null = null;
  private channel: ConfirmChannel | null = null;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  private invalidate(connection: AmqpConnection, channel?: ConfirmChannel): void {
    if (channel && this.channel !== channel) return;
    if (this.connection !== connection) return;
    this.channel = null;
    this.connection = null;
  }

  private async confirmChannel(): Promise<ConfirmChannel> {
    if (this.channel) return this.channel;
    // Runtime require keeps the adapter isolated until the integration owner adds amqplib.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const amqp = require('amqplib') as AmqpModule;
    const connection = await amqp.connect(this.config.getOrThrow<string>('RABBITMQ_URL'));
    const channel = await connection.createConfirmChannel();
    connection.on('error', () => this.invalidate(connection));
    connection.on('close', () => this.invalidate(connection));
    channel.on('error', () => this.invalidate(connection, channel));
    channel.on('close', () => this.invalidate(connection, channel));
    this.connection = connection;
    this.channel = channel;
    return channel;
  }

  async publish(queue: string, messageId: string, payload: JobMessage): Promise<void> {
    const channel = await this.confirmChannel();
    try {
      await channel.assertQueue(queue, { durable: true });
      channel.sendToQueue(queue, Buffer.from(JSON.stringify(payload)), {
        persistent: true,
        contentType: 'application/json',
        messageId,
      });
      await channel.waitForConfirms();
    } catch (error) {
      const connection = this.connection;
      if (connection) this.invalidate(connection, channel);
      await channel.close().catch(() => undefined);
      await connection?.close().catch(() => undefined);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;
    await channel?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
  }
}
