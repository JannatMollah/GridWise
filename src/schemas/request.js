const { z } = require("zod");

// ── Hour entry schema ──
const hourEntrySchema = z.object({
  hour: z.number().int().min(0).max(23),
  demand_kwh: z.number().nonnegative(),
  solar_kwh: z.number().nonnegative(),
  tariff_bdt_per_kwh: z.number().nonnegative(),
});

// ── Battery object schema ──
const batterySchema = z.object({
  capacity_kwh: z.number().positive(),
  initial_energy_kwh: z.number().nonnegative(),
  minimum_energy_kwh: z.number().nonnegative(),
  max_charge_kwh_per_hour: z.number().nonnegative(),
  max_discharge_kwh_per_hour: z.number().nonnegative(),
});

// ── Full request schema ──
const optimizeEnergyRequestSchema = z.object({
  scenario_id: z.string().min(1),
  operator_notes: z
    .array(z.string().min(1))
    .min(1)
    .max(3),
  hours: z
    .array(hourEntrySchema)
    .length(24)
    .refine(
      (hours) => {
        const hourNums = hours.map((h) => h.hour).sort((a, b) => a - b);
        return (
          hourNums.length === 24 &&
          hourNums.every((h, i) => h === i)
        );
      },
      { message: "hours must contain exactly 24 unique entries for hours 0 through 23" }
    ),
  battery: batterySchema,
});

module.exports = { optimizeEnergyRequestSchema, hourEntrySchema, batterySchema };
