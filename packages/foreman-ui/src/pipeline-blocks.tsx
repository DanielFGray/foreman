/**
 * The palette and the block inspector beside the pipeline editor's drawing
 * (docs/web-ui.md, "Building a pipeline"). The palette places a block wired to
 * nothing; the inspector sets the selected block and its exits. Each control
 * sends one PipelineChange through the editor's queue, so the server checks it
 * as it checks a dragged rejoin.
 */
import { type DrawnNode, WORKSPACE_CHOICES, type WorkspaceChoice } from "foreman/pipeline";
import { PLACEABLE, type Placeable } from "foreman/pipeline-belt";
import type { PipelineChange } from "foreman/pipeline-edit";
import type { ChoicesView, SeatOffersView } from "foreman/pipeline-view";
import { type FormEvent, type ReactNode, useState } from "react";

type Edit = (change: PipelineChange) => void;

/**
 * Places a new block of the chosen kind, named by the operator, wired to
 * nothing. While the drawing has no blocks, it also starts the drawing from a
 * standard pipeline; once a block exists, that control is gone.
 */
export const Palette = ({
  composites,
  empty,
  onEdit,
}: {
  readonly composites: ReadonlyArray<string>;
  readonly empty: boolean;
  readonly onEdit: Edit;
}) => {
  const kinds = PLACEABLE.filter((kind) => kind !== "composite" || composites.length > 0);
  const [kind, setKind] = useState<Placeable>("gate");
  const [of, setOf] = useState(composites[0] ?? "");
  const [id, setId] = useState("");
  const [standard, setStandard] = useState<WorkspaceChoice>("checkout");
  const name = id.trim();

  const place = (event: FormEvent) => {
    event.preventDefault();
    if (name === "") return;
    onEdit({ _tag: "Place", kind, id: name, ...(kind === "composite" ? { of } : {}) });
    setId("");
  };

  return (
    <form className="pipeline-palette" data-testid="pipeline-palette" onSubmit={place}>
      {empty ? (
        <>
          <select
            aria-label="Start from"
            data-testid="palette-standard"
            value={standard}
            onChange={(event) => setStandard(workspaceOf(event.target.value))}
          >
            {WORKSPACE_CHOICES.map((one) => (
              <option key={one} value={one}>
                {one}
              </option>
            ))}
          </select>
          {/* type="button": a submit here would also send the Place form's change. */}
          <button
            type="button"
            data-testid="palette-start"
            onClick={() => onEdit({ _tag: "StartFrom", standard })}
          >
            Start
          </button>
        </>
      ) : null}
      <select
        aria-label="Block kind"
        data-testid="palette-kind"
        value={kind}
        onChange={(event) => setKind(placeableOf(event.target.value))}
      >
        {kinds.map((one) => (
          <option key={one} value={one}>
            {one}
          </option>
        ))}
      </select>
      {kind === "composite" ? (
        <select
          aria-label="Composite"
          data-testid="palette-of"
          value={of}
          onChange={(event) => setOf(event.target.value)}
        >
          {composites.map((one) => (
            <option key={one} value={one}>
              {one}
            </option>
          ))}
        </select>
      ) : null}
      <input
        aria-label="Block id"
        data-testid="palette-id"
        placeholder="id"
        value={id}
        onChange={(event) => setId(event.target.value)}
      />
      <button type="submit" data-testid="palette-place" disabled={name === ""}>
        Place
      </button>
    </form>
  );
};

/**
 * The settings of the selected block. Its form is keyed by the block as drawn,
 * so a server answer that changes the block resets what the form shows.
 */
export const Inspector = ({
  node,
  choices,
  offers,
  onEdit,
}: {
  readonly node: DrawnNode | undefined;
  readonly choices: ChoicesView;
  readonly offers: SeatOffersView;
  readonly onEdit: Edit;
}) => {
  if (node === undefined) {
    return (
      <div className="pipeline-inspector" data-testid="pipeline-inspector">
        <p className="muted">Click a block to set it up.</p>
      </div>
    );
  }
  return (
    <div className="pipeline-inspector" data-testid="pipeline-inspector">
      <div className="inspector-head">
        <strong data-testid="inspector-block" data-block={node.id}>
          {node.kind} {node.id}
        </strong>
        <button
          type="button"
          data-testid="inspector-remove"
          onClick={() => onEdit({ _tag: "Remove", id: node.id })}
        >
          Remove
        </button>
      </div>
      <Forms
        key={JSON.stringify(node)}
        node={node}
        choices={choices}
        offers={offers}
        onEdit={onEdit}
      />
    </div>
  );
};

/** Every form of the block, for the inspector to key as one. */
const Forms = ({
  node,
  choices,
  offers,
  onEdit,
}: {
  readonly node: DrawnNode;
  readonly choices: ChoicesView;
  readonly offers: SeatOffersView;
  readonly onEdit: Edit;
}) => (
  <>
    <Settings node={node} choices={choices} offers={offers} onEdit={onEdit} />
    {node.kind === "router" ? <Routes node={node} onEdit={onEdit} /> : null}
    {node.kind === "agent" || node.kind === "check" ? <Exits node={node} onEdit={onEdit} /> : null}
  </>
);

/** The Configure form of a block whose kind has settings; nothing for the rest. */
const Settings = ({
  node,
  choices,
  offers,
  onEdit,
}: {
  readonly node: DrawnNode;
  readonly choices: ChoicesView;
  readonly offers: SeatOffersView;
  readonly onEdit: Edit;
}) => {
  switch (node.kind) {
    case "source":
      return (
        <TextSetting
          label="Filter"
          testId="inspector-filter"
          initial={node.filter}
          onSet={(filter) =>
            onEdit({ _tag: "Configure", id: node.id, setting: { kind: "source", filter } })
          }
        />
      );
    case "check":
      return (
        <TextSetting
          label="Command"
          testId="inspector-command"
          initial={node.command}
          onSet={(command) =>
            onEdit({ _tag: "Configure", id: node.id, setting: { kind: "check", command } })
          }
        />
      );
    case "gate":
      return <GateSetting node={node} steps={choices.steps} onEdit={onEdit} />;
    case "agent":
      return <AgentSetting node={node} roles={choices.roles} offers={offers} onEdit={onEdit} />;
    case "land":
      return <LandSetting node={node} landings={choices.landings} onEdit={onEdit} />;
    default:
      return null;
  }
};

const GateSetting = ({
  node,
  steps,
  onEdit,
}: {
  readonly node: Extract<DrawnNode, { kind: "gate" }>;
  readonly steps: ChoicesView["steps"];
  readonly onEdit: Edit;
}) => {
  const [step, setStep] = useState(node.step);
  return (
    <SettingForm
      onSet={() => onEdit({ _tag: "Configure", id: node.id, setting: { kind: "gate", step } })}
    >
      <Choice
        label="Step"
        testId="inspector-step"
        value={step}
        options={steps}
        onChange={(value) => setStep(oneOf(steps, value, step))}
      />
    </SettingForm>
  );
};

/**
 * An agent's role and model. A new role resets the model to that role's pool
 * (`ladder` or `reviewers`), since a rung cannot review and a reviewer cannot
 * author. Slots and vars are kept as drawn.
 */
const AgentSetting = ({
  node,
  roles,
  offers,
  onEdit,
}: {
  readonly node: Extract<DrawnNode, { kind: "agent" }>;
  readonly roles: ChoicesView["roles"];
  readonly offers: SeatOffersView;
  readonly onEdit: Edit;
}) => {
  const [role, setRole] = useState(node.role);
  const [model, setModel] = useState(node.model);
  const models = modelsFor(role, offers);
  return (
    <SettingForm
      onSet={() =>
        onEdit({
          _tag: "Configure",
          id: node.id,
          setting: {
            kind: "agent",
            role,
            model,
            ...(node.slots === undefined ? {} : { slots: node.slots }),
            ...(node.vars === undefined ? {} : { vars: node.vars }),
          },
        })
      }
    >
      <Choice
        label="Role"
        testId="inspector-role"
        value={role}
        options={roles}
        onChange={(value) => {
          const next = oneOf(roles, value, role);
          setRole(next);
          if (next !== role) setModel(poolOf(next));
        }}
      />
      <Choice
        label="Model"
        testId="inspector-model"
        value={model}
        options={models.includes(model) ? models : [model, ...models]}
        onChange={setModel}
      />
    </SettingForm>
  );
};

const LandSetting = ({
  node,
  landings,
  onEdit,
}: {
  readonly node: Extract<DrawnNode, { kind: "land" }>;
  readonly landings: ChoicesView["landings"];
  readonly onEdit: Edit;
}) => {
  const [how, setHow] = useState(node.how ?? "merge");
  const [onto, setOnto] = useState(node.onto ?? "");
  return (
    <SettingForm
      onSet={() =>
        onEdit({
          _tag: "Configure",
          id: node.id,
          setting: { kind: "land", how, onto: onto.trim() === "" ? undefined : onto.trim() },
        })
      }
    >
      <Choice
        label="How"
        testId="inspector-how"
        value={how}
        options={landings}
        onChange={(value) => setHow(oneOf(landings, value, how))}
      />
      <label>
        Onto
        <input
          data-testid="inspector-onto"
          placeholder="the checkout's branch"
          value={onto}
          onChange={(event) => setOnto(event.target.value)}
        />
      </label>
    </SettingForm>
  );
};

/** A router's routes in order, each removable, and a form that adds one. */
const Routes = ({
  node,
  onEdit,
}: {
  readonly node: Extract<DrawnNode, { kind: "router" }>;
  readonly onEdit: Edit;
}) => {
  const [when, setWhen] = useState("");
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (when.trim() === "") return;
    onEdit({ _tag: "AddRoute", router: node.id, when: when.trim() });
  };
  return (
    <div className="inspector-list">
      <ol>
        {node.routes.map((route, index) => (
          <li key={index}>
            <code>{route.when}</code>
            <button
              type="button"
              data-testid={`inspector-route-remove-${index}`}
              onClick={() => onEdit({ _tag: "RemoveRoute", router: node.id, index })}
            >
              Remove
            </button>
          </li>
        ))}
      </ol>
      <form className="inspector-row" onSubmit={add}>
        <input
          aria-label="Route condition"
          data-testid="inspector-route-when"
          placeholder="when, e.g. failed"
          value={when}
          onChange={(event) => setWhen(event.target.value)}
        />
        <button type="submit" data-testid="inspector-route-add" disabled={when.trim() === ""}>
          Add route
        </button>
      </form>
    </div>
  );
};

/** An agent's or a check's exits: each renamed, marked or charged on its own, and a form that adds one. */
const Exits = ({
  node,
  onEdit,
}: {
  readonly node: Extract<DrawnNode, { kind: "agent" | "check" }>;
  readonly onEdit: Edit;
}) => {
  const [added, setAdded] = useState("");
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (added.trim() === "") return;
    onEdit({ _tag: "AddExit", id: node.id, name: added.trim() });
  };
  return (
    <div className="inspector-list">
      <ul>
        {node.exits.map((exit) => (
          <ExitRow key={exit.id} block={node.id} exit={exit} onEdit={onEdit} />
        ))}
      </ul>
      <form className="inspector-row" onSubmit={add}>
        <input
          aria-label="New exit name"
          data-testid="inspector-exit-add-name"
          placeholder="exit name"
          value={added}
          onChange={(event) => setAdded(event.target.value)}
        />
        <button type="submit" data-testid="inspector-exit-add" disabled={added.trim() === ""}>
          Add exit
        </button>
      </form>
    </div>
  );
};

const ExitRow = ({
  block,
  exit,
  onEdit,
}: {
  readonly block: string;
  readonly exit: Extract<DrawnNode, { kind: "agent" }>["exits"][number];
  readonly onEdit: Edit;
}) => {
  const [name, setName] = useState(exit.name);
  const testId = `inspector-exit-${exit.name}`;
  const rename = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "" || name.trim() === exit.name) return;
    onEdit({ _tag: "RenameExit", id: block, name: exit.name, to: name.trim() });
  };
  return (
    <li className="inspector-exit" data-testid={testId}>
      <form className="inspector-row" onSubmit={rename}>
        <input
          aria-label={`Name of exit ${exit.name}`}
          data-testid={`${testId}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" data-testid={`${testId}-rename`}>
          Rename
        </button>
      </form>
      <div className="inspector-row">
        <Choice
          label="Empty branch"
          testId={`${testId}-empty`}
          value={exit.empty ?? ""}
          options={["", "claim"]}
          names={{ "": "unfinished", claim: "claim" }}
          onChange={(value) =>
            onEdit({
              _tag: "SetEmpty",
              id: block,
              name: exit.name,
              empty: value === "claim" ? "claim" : undefined,
            })
          }
        />
        <Choice
          label="Charges"
          testId={`${testId}-fails`}
          value={exit.fails ?? ""}
          options={["", "author", "self"]}
          names={{ "": "no rung", author: "author", self: "self" }}
          onChange={(value) =>
            onEdit({
              _tag: "ChargeExit",
              id: block,
              name: exit.name,
              fails: value === "author" || value === "self" ? value : undefined,
            })
          }
        />
        <button
          type="button"
          data-testid={`${testId}-remove`}
          onClick={() => onEdit({ _tag: "RemoveExit", id: block, name: exit.name })}
        >
          Remove
        </button>
      </div>
    </li>
  );
};

/** A form with one Set button, for the settings that go to the server together. */
const SettingForm = ({
  onSet,
  children,
}: {
  readonly onSet: () => void;
  readonly children: ReactNode;
}) => (
  <form
    className="inspector-row"
    onSubmit={(event) => {
      event.preventDefault();
      onSet();
    }}
  >
    {children}
    <button type="submit" data-testid="inspector-set">
      Set
    </button>
  </form>
);

const TextSetting = ({
  label,
  testId,
  initial,
  onSet,
}: {
  readonly label: string;
  readonly testId: string;
  readonly initial: string;
  readonly onSet: (value: string) => void;
}) => {
  const [value, setValue] = useState(initial);
  return (
    <SettingForm onSet={() => onSet(value)}>
      <label>
        {label}
        <input
          data-testid={testId}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
    </SettingForm>
  );
};

const Choice = ({
  label,
  testId,
  value,
  options,
  names = {},
  onChange,
}: {
  readonly label: string;
  readonly testId: string;
  readonly value: string;
  readonly options: ReadonlyArray<string>;
  readonly names?: Readonly<Record<string, string>>;
  readonly onChange: (value: string) => void;
}) => (
  <label>
    {label}
    <select data-testid={testId} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((one) => (
        <option key={one} value={one}>
          {names[one] ?? one}
        </option>
      ))}
    </select>
  </label>
);

/** The pool an agent of `role` draws from when it names no one seat. */
const poolOf = (role: "author" | "review"): string => (role === "author" ? "ladder" : "reviewers");

/** What an agent of `role` may name: its pool, then each seat the fleet offers that role. */
const modelsFor = (role: "author" | "review", offers: SeatOffersView): ReadonlyArray<string> => [
  poolOf(role),
  ...(role === "author"
    ? offers.rungs.filter((rung) => rung.author).map((rung) => rung.name)
    : offers.reviewers),
];

/** `value` when it is one of `options`, else `fallback`: a select only offers its options. */
const oneOf = <A extends string>(options: ReadonlyArray<A>, value: string, fallback: A): A =>
  options.find((one) => one === value) ?? fallback;

const placeableOf = (value: string): Placeable => oneOf(PLACEABLE, value, "gate");
const workspaceOf = (value: string): WorkspaceChoice => oneOf(WORKSPACE_CHOICES, value, "checkout");
