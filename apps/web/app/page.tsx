import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Label } from "@workspace/ui/components/label"
import { Textarea } from "@workspace/ui/components/textarea"

export default function Page() {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-3xl items-center px-4 py-10">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-xl md:text-2xl">Convert links to ZIP</CardTitle>
          <CardDescription>Paste one source URL per line.</CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="urls">URLs</Label>
            <Textarea id="urls" name="urls" rows={12} placeholder="One URL per line" />
          </div>

          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground">Batches may take a few minutes.</p>
            <Button>Convert</Button>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
