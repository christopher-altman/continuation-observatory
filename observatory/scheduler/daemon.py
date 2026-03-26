"""Scheduler daemon — runs indefinitely.

Starts AsyncIOScheduler, registers probe and sweep jobs, then blocks until
SIGTERM / KeyboardInterrupt.  All scheduling logic lives in scheduler.py;
this module is purely the long-running entry point.

Usage (via Makefile):
    make run-scheduler          # blocks forever
    DRY_RUN=true make run-scheduler   # dry-run mode
"""
from __future__ import annotations

import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from observatory.config import settings
from observatory.scheduler.scheduler import run_cycle, run_sweep_cycle

logger = logging.getLogger(__name__)


def _run_cycle_job() -> None:
    rows = run_cycle()
    logger.info("Probe cycle complete: %d probe_run rows written", rows)


def _run_sweep_job() -> None:
    rows = run_sweep_cycle()
    logger.info("Sweep cycle complete: %d probe_run rows written", rows)


async def _run_daemon() -> None:
    scheduler = AsyncIOScheduler(timezone=settings.scheduler_timezone)

    scheduler.add_job(
        _run_cycle_job,
        "interval",
        hours=6,
        id="probe_cycle",
        replace_existing=True,
    )
    scheduler.add_job(
        _run_sweep_job,
        "cron",
        day_of_week="sun",
        hour=2,
        id="sweep_cycle",
        replace_existing=True,
    )

    scheduler.start()
    logger.info(
        "Scheduler daemon started.  "
        "Probe interval: every 6 h | Sweep: Sunday 02:00 %s",
        settings.scheduler_timezone,
    )

    try:
        await asyncio.Event().wait()  # block until SIGTERM / KeyboardInterrupt
    except (KeyboardInterrupt, SystemExit):
        logger.info("Scheduler daemon stopping…")
    finally:
        scheduler.shutdown(wait=False)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    asyncio.run(_run_daemon())


if __name__ == "__main__":
    main()
