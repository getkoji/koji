"use client";

import {
  Button,
  Badge,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Input,
  Label,
  Textarea,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Switch,
  Checkbox,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
  Separator,
  Skeleton,
  Progress,
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
  Alert,
  AlertTitle,
  AlertDescription,
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipContent,
  Toggle,
} from "@koji/ui";

export default function FixturesPage() {
  return (
    <TooltipProvider>
      <div className="max-w-4xl space-y-12">
        <div>
          <h1
            className="font-display text-3xl font-medium tracking-tight mb-1"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
          >
            Component fixtures
          </h1>
          <p className="text-sm text-muted-foreground">
            Visual review of @koji/ui after the brand pass (platform-21 → 23).
          </p>
        </div>

        {/* Buttons */}
        <Section title="Buttons">
          <div className="flex flex-wrap gap-3 items-center">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="link">Link</Button>
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
            <Button disabled>Disabled</Button>
          </div>
        </Section>

        {/* Badges */}
        <Section title="Badges">
          <div className="flex flex-wrap gap-2">
            <Badge>Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="destructive">Destructive</Badge>
          </div>
        </Section>

        {/* Inputs */}
        <Section title="Form inputs">
          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <Label htmlFor="name">Schema name</Label>
              <Input id="name" placeholder="e.g. invoice" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" placeholder="admin@acme.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="desc">Description</Label>
              <Textarea id="desc" placeholder="Describe the extraction target…" />
            </div>
            <div className="space-y-2">
              <Label>Model provider</Label>
              <Select>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="azure">Azure OpenAI</SelectItem>
                  <SelectItem value="bedrock">AWS Bedrock</SelectItem>
                  <SelectItem value="ollama">Ollama</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-3">
              <Switch id="auto-run" />
              <Label htmlFor="auto-run">Auto-run on save</Label>
            </div>
            <div className="flex items-center gap-3">
              <Checkbox id="agree" />
              <Label htmlFor="agree">I understand this is destructive</Label>
            </div>
          </div>
        </Section>

        {/* Cards */}
        <Section title="Cards">
          <div className="grid grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>invoice</CardTitle>
                <CardDescription>Extracts line items, totals, and vendor info from PDF invoices.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex gap-4 font-mono text-xs text-muted-foreground">
                  <span>v13</span>
                  <span>38 corpus</span>
                  <span>98.5% accuracy</span>
                </div>
              </CardContent>
              <CardFooter className="flex gap-2">
                <Button size="sm">Open</Button>
                <Button size="sm" variant="outline">Deploy</Button>
              </CardFooter>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>claim</CardTitle>
                <CardDescription>Insurance claim form extraction — multi-page, mixed formats.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex gap-4 font-mono text-xs text-muted-foreground">
                  <span>v7</span>
                  <span>12 corpus</span>
                  <span>94.2% accuracy</span>
                </div>
              </CardContent>
              <CardFooter className="flex gap-2">
                <Button size="sm">Open</Button>
                <Button size="sm" variant="outline">Deploy</Button>
              </CardFooter>
            </Card>
          </div>
        </Section>

        {/* Tabs */}
        <Section title="Tabs">
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="corpus">Corpus</TabsTrigger>
              <TabsTrigger value="runs">Runs</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="pt-4 text-sm text-muted-foreground">
              Overview content goes here. This tab shows the schema summary.
            </TabsContent>
            <TabsContent value="corpus" className="pt-4 text-sm text-muted-foreground">
              Corpus entries listed here.
            </TabsContent>
          </Tabs>
        </Section>

        {/* Table */}
        <Section title="Table">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead>Pipeline</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Docs</TableHead>
                <TableHead className="text-right">Accuracy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[
                { job: "job-20260414-1442-a91c", pipeline: "claims-intake", status: "complete", docs: 47, accuracy: "98.2%" },
                { job: "job-20260414-0903-b2df", pipeline: "invoice-ingest", status: "running", docs: 12, accuracy: "—" },
                { job: "job-20260413-2201-c4e1", pipeline: "claims-intake", status: "failed", docs: 3, accuracy: "—" },
              ].map((r) => (
                <TableRow key={r.job}>
                  <TableCell className="font-mono text-xs">{r.job}</TableCell>
                  <TableCell>{r.pipeline}</TableCell>
                  <TableCell>
                    <Badge variant={r.status === "complete" ? "secondary" : r.status === "failed" ? "destructive" : "outline"}>
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono">{r.docs}</TableCell>
                  <TableCell className="text-right font-mono">{r.accuracy}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>

        {/* Dialog */}
        <Section title="Dialog">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Open dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Deploy schema</DialogTitle>
                <DialogDescription>
                  This will set <code className="font-mono">invoice v13</code> as the active version
                  for the production pipeline.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button>Deploy</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </Section>

        {/* Alerts */}
        <Section title="Alerts">
          <div className="space-y-3">
            <Alert>
              <AlertTitle>Heads up</AlertTitle>
              <AlertDescription>
                3 corpus entries have unreviewed ground truth — run results may be noisy.
              </AlertDescription>
            </Alert>
            <Alert variant="destructive">
              <AlertTitle>Regression detected</AlertTitle>
              <AlertDescription>
                Schema <code className="font-mono">invoice v13</code> regressed on 2 fields vs the v12 baseline.
              </AlertDescription>
            </Alert>
          </div>
        </Section>

        {/* Misc */}
        <Section title="Miscellaneous">
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Progress</p>
              <Progress value={72} />
            </div>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Skeleton loading</p>
              <div className="flex gap-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-4 w-32" />
                </div>
              </div>
            </div>
            <Separator />
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm">Hover me</Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>This is a tooltip with the Koji palette</p>
                </TooltipContent>
              </Tooltip>
              <Toggle aria-label="Toggle bold">
                <span className="font-mono text-xs">B</span>
              </Toggle>
            </div>
          </div>
        </Section>
      </div>
    </TooltipProvider>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-muted-foreground mb-4">
        {title}
      </h2>
      {children}
    </section>
  );
}
