/** 可注入的时钟：抓取时间、快照日期都从这里取，测试可拨动。 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
