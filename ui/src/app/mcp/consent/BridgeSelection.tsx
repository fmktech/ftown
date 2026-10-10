"use client";

import { useState } from "react";

export default function BridgeSelection({
  devices,
}: {
  devices: { bridgeId: string; hostname: string | null }[];
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const selectedIds = new Set(selected);
  const count = devices.filter((device) => selectedIds.has(device.bridgeId)).length;
  const allSelected = devices.length > 0 && count === devices.length;
  const partiallySelected = count > 0 && !allSelected;

  return (
    <fieldset>
      <legend className="font-semibold mb-2">
        Allow access to these computers
      </legend>
      {devices.length > 0 ? (
        <>
          <label className="block py-2 font-semibold">
            <input
              type="checkbox"
              checked={allSelected}
              aria-checked={partiallySelected ? "mixed" : allSelected}
              ref={(input) => {
                if (input) input.indeterminate = partiallySelected;
              }}
              onChange={(event) =>
                setSelected(event.target.checked ? devices.map((d) => d.bridgeId) : [])
              }
            />{" "}
            All available computers ({devices.length})
          </label>
          <p className="text-sm mb-2">
            Includes the computers listed below. Computers added later require new consent.
          </p>
          {devices.map((device) => (
            <label key={device.bridgeId} className="block py-2">
              <input
                type="checkbox"
                name="machine"
                value={device.bridgeId}
                checked={selectedIds.has(device.bridgeId)}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setSelected((previous) => checked
                    ? [...previous, device.bridgeId]
                    : previous.filter((id) => id !== device.bridgeId));
                }}
              />{" "}
              {device.hostname ?? device.bridgeId}
            </label>
          ))}
        </>
      ) : (
        <p>No authorized computers are available for this account.</p>
      )}
    </fieldset>
  );
}
