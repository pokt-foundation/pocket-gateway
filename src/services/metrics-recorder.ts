import {Redis} from 'ioredis';
import {Pool as PGPool} from 'pg';
import {CherryPicker} from './cherry-picker';

const pgFormat = require('pg-format');
const logger = require('../services/logger');

export class MetricsRecorder {
  redis: Redis;
  pgPool: PGPool;
  cherryPicker: CherryPicker;
  processUID: string;

  constructor({
    redis,
    pgPool,
    cherryPicker,
    processUID,
  }: {
    redis: Redis;
    pgPool: PGPool;
    cherryPicker: CherryPicker;
    processUID: string;
  }) {
    this.redis = redis;
    this.pgPool = pgPool;
    this.cherryPicker = cherryPicker;
    this.processUID = processUID;
  }

  // Record relay metrics in redis then push to timescaleDB for analytics
  async recordMetric({
    requestID,
    applicationID,
    appPubKey,
    blockchain,
    serviceNode,
    relayStart,
    result,
    bytes,
    delivered,
    fallback,
    method,
    error,
  }: {
    requestID: string;
    applicationID: string;
    appPubKey: string;
    blockchain: string;
    serviceNode: string | undefined;
    relayStart: [number, number];
    result: number;
    bytes: number;
    delivered: boolean;
    fallback: boolean;
    method: string | undefined;
    error: string | undefined;
  }): Promise<void> {
    try {
      const relayEnd = process.hrtime(relayStart);
      const elapsedTime = (relayEnd[0] * 1e9 + relayEnd[1]) / 1e9;
      let fallbackTag = '';

      if (fallback) {
        fallbackTag = ' FALLBACK';
      }

      if (result === 200) {
        logger.log('info', 'SUCCESS' + fallbackTag, {requestID: requestID, relayType: 'APP', typeID: applicationID, serviceNode: serviceNode});
      } else if (result === 500) {
        logger.log('error', 'FAILURE' + fallbackTag + ' ' + error, {requestID: requestID, relayType: 'APP', typeID: applicationID, serviceNode: serviceNode});
      } else if (result === 503) {
        logger.log('error', 'INVALID RESPONSE' + fallbackTag + ' ' + error, {requestID: requestID, relayType: 'APP', typeID: applicationID, serviceNode: serviceNode});
      }

      const metricsValues = [
        new Date(),
        appPubKey,
        blockchain,
        serviceNode,
        elapsedTime,
        result,
        bytes,
        method,
      ];

      // Store metrics in redis and every 10 seconds, push to postgres
      const redisMetricsKey = 'metrics-' + this.processUID;
      const redisListAge = await this.redis.get('age-' + redisMetricsKey);
      const redisListSize = await this.redis.llen(redisMetricsKey);
      const currentTimestamp = Math.floor(new Date().getTime() / 1000);

      // List has been started in redis and needs to be pushed as timestamp is > 10 seconds old
      if (
        redisListAge &&
        redisListSize > 0 &&
        currentTimestamp > parseInt(redisListAge) + 10
      ) {
        await this.redis.set('age-' + redisMetricsKey, currentTimestamp);

        const bulkData = [metricsValues];
        for (let count = 0; count < redisListSize; count++) {
          const redisRecord = await this.redis.lpop(redisMetricsKey);
          bulkData.push(JSON.parse(redisRecord));
        }
        const metricsQuery = pgFormat('INSERT INTO relay VALUES %L', bulkData);
        this.pgPool.query(metricsQuery);
      } else {
        await this.redis.rpush(redisMetricsKey, JSON.stringify(metricsValues));
      }

      if (!redisListAge) {
        await this.redis.set('age-' + redisMetricsKey, currentTimestamp);
      }

      if (serviceNode) {
        await this.cherryPicker.updateServiceQuality(
          blockchain,
          applicationID,
          serviceNode,
          elapsedTime,
          result,
        );
      }
    } catch (err) {
      logger.log('error', err.stack);
    }
  }
}
