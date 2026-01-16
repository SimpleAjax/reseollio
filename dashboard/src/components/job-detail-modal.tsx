"use client";

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/status-badge";
import { type Job } from "@/lib/dummy-data";
import {
    Calendar,
    Clock,
    Hash,
    Key,
    RotateCcw,
    Trash2,
    Copy,
    CheckCircle2,
} from "lucide-react";
import { format } from "date-fns";
import { useState } from "react";

interface JobDetailModalProps {
    job: Job | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function JobDetailModal({ job, open, onOpenChange }: JobDetailModalProps) {
    const [copied, setCopied] = useState(false);

    if (!job) return null;

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const formatDuration = (ms?: number) => {
        if (!ms) return "N/A";
        if (ms < 1000) return `${ms}ms`;
        return `${(ms / 1000).toFixed(2)}s`;
    };

    // Sample job arguments and result for demonstration
    const sampleArgs = {
        userId: "user_abc123",
        amount: 4999,
        currency: "USD",
        paymentMethod: "stripe",
    };

    const sampleResult = job.status === "SUCCESS"
        ? {
            transactionId: "txn_xyz789",
            status: "completed",
            processedAt: new Date().toISOString(),
        }
        : null;

    const sampleAttempts = Array.from({ length: job.attempt }, (_, i) => ({
        attempt: i + 1,
        startedAt: new Date(Date.now() - (job.attempt - i) * 60000),
        completedAt: new Date(Date.now() - (job.attempt - i - 1) * 60000),
        success: i + 1 === job.attempt && job.status === "SUCCESS",
        error: i + 1 !== job.attempt || job.status !== "SUCCESS" ? job.error : undefined,
    }));

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <div className="flex items-center justify-between">
                        <DialogTitle className="text-2xl font-bold">Job Details</DialogTitle>
                        <StatusBadge status={job.status} />
                    </div>
                    <DialogDescription className="font-mono text-sm">
                        {job.name}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-6 mt-4">
                    {/* Overview Section */}
                    <div>
                        <h3 className="text-sm font-semibold text-muted-foreground uppercase mb-3">
                            Overview
                        </h3>
                        <div className="grid grid-cols-2 gap-4">
                            <InfoItem
                                icon={Hash}
                                label="Job ID"
                                value={job.id}
                                copyable
                                onCopy={() => copyToClipboard(job.id)}
                                copied={copied}
                            />
                            <InfoItem
                                icon={RotateCcw}
                                label="Attempts"
                                value={`${job.attempt} / ${job.maxAttempts}`}
                            />
                            <InfoItem
                                icon={Calendar}
                                label="Created At"
                                value={format(job.createdAt, "PPpp")}
                            />
                            {job.scheduledAt && (
                                <InfoItem
                                    icon={Clock}
                                    label="Scheduled At"
                                    value={format(job.scheduledAt, "PPpp")}
                                />
                            )}
                            {job.startedAt && (
                                <InfoItem
                                    icon={Clock}
                                    label="Started At"
                                    value={format(job.startedAt, "PPpp")}
                                />
                            )}
                            {job.completedAt && (
                                <InfoItem
                                    icon={CheckCircle2}
                                    label="Completed At"
                                    value={format(job.completedAt, "PPpp")}
                                />
                            )}
                            {job.duration && (
                                <InfoItem
                                    icon={Clock}
                                    label="Duration"
                                    value={formatDuration(job.duration)}
                                />
                            )}
                            {job.idempotencyKey && (
                                <InfoItem
                                    icon={Key}
                                    label="Idempotency Key"
                                    value={job.idempotencyKey}
                                    copyable
                                    onCopy={() => copyToClipboard(job.idempotencyKey!)}
                                    copied={copied}
                                />
                            )}
                        </div>
                    </div>

                    <Separator />

                    {/* Arguments Section */}
                    <div>
                        <h3 className="text-sm font-semibold text-muted-foreground uppercase mb-3">
                            Job Arguments
                        </h3>
                        <div className="bg-muted/50 rounded-lg p-4">
                            <pre className="text-xs font-mono overflow-x-auto">
                                {JSON.stringify(sampleArgs, null, 2)}
                            </pre>
                        </div>
                    </div>

                    {/* Result Section */}
                    {job.status === "SUCCESS" && sampleResult && (
                        <>
                            <Separator />
                            <div>
                                <h3 className="text-sm font-semibold text-muted-foreground uppercase mb-3">
                                    Job Result
                                </h3>
                                <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4">
                                    <pre className="text-xs font-mono overflow-x-auto text-green-700 dark:text-green-400">
                                        {JSON.stringify(sampleResult, null, 2)}
                                    </pre>
                                </div>
                            </div>
                        </>
                    )}

                    {/* Error Section */}
                    {job.error && (
                        <>
                            <Separator />
                            <div>
                                <h3 className="text-sm font-semibold text-muted-foreground uppercase mb-3">
                                    Error Details
                                </h3>
                                <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4">
                                    <p className="text-sm text-red-700 dark:text-red-400 font-mono">
                                        {job.error}
                                    </p>
                                    <div className="mt-3 text-xs text-muted-foreground">
                                        <p className="font-mono">Stack trace:</p>
                                        <pre className="mt-1 text-xs opacity-70">
                                            {`  at processPayment (orders/payment.ts:42:15)
  at async executeJob (worker.ts:89:22)
  at async Worker.run (worker.ts:134:18)`}
                                        </pre>
                                    </div>
                                </div>
                            </div>
                        </>
                    )}

                    {/* Retry History */}
                    {job.attempt > 0 && (
                        <>
                            <Separator />
                            <div>
                                <h3 className="text-sm font-semibold text-muted-foreground uppercase mb-3">
                                    Retry History
                                </h3>
                                <div className="space-y-3">
                                    {sampleAttempts.map((attempt) => (
                                        <div
                                            key={attempt.attempt}
                                            className="flex items-start gap-3 p-3 rounded-lg border bg-card/50"
                                        >
                                            <div className="flex-shrink-0 h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                                                <span className="text-xs font-bold">{attempt.attempt}</span>
                                            </div>
                                            <div className="flex-1 space-y-1">
                                                <div className="flex items-center justify-between">
                                                    <span className="text-sm font-medium">
                                                        Attempt {attempt.attempt}
                                                    </span>
                                                    <Badge
                                                        variant={attempt.success ? "default" : "destructive"}
                                                        className="text-xs"
                                                    >
                                                        {attempt.success ? "Success" : "Failed"}
                                                    </Badge>
                                                </div>
                                                <div className="text-xs text-muted-foreground space-y-0.5">
                                                    <p>Started: {format(attempt.startedAt, "PPpp")}</p>
                                                    <p>Completed: {format(attempt.completedAt, "PPpp")}</p>
                                                    <p>
                                                        Duration:{" "}
                                                        {formatDuration(
                                                            attempt.completedAt.getTime() - attempt.startedAt.getTime()
                                                        )}
                                                    </p>
                                                </div>
                                                {attempt.error && (
                                                    <p className="text-xs text-red-600 dark:text-red-400 font-mono mt-2">
                                                        {attempt.error}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </>
                    )}

                    {/* Actions */}
                    <Separator />
                    <div className="flex items-center justify-end gap-2">
                        {(job.status === "FAILED" || job.status === "DEAD") && (
                            <Button variant="outline" className="gap-2">
                                <RotateCcw className="h-4 w-4" />
                                Retry Job
                            </Button>
                        )}
                        <Button variant="destructive" className="gap-2">
                            <Trash2 className="h-4 w-4" />
                            Delete Job
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

interface InfoItemProps {
    icon: React.ElementType;
    label: string;
    value: string;
    copyable?: boolean;
    onCopy?: () => void;
    copied?: boolean;
}

function InfoItem({ icon: Icon, label, value, copyable, onCopy, copied }: InfoItemProps) {
    return (
        <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon className="h-3.5 w-3.5" />
                <span>{label}</span>
            </div>
            <div className="flex items-center gap-2">
                <p className="text-sm font-medium font-mono truncate">{value}</p>
                {copyable && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={onCopy}
                    >
                        {copied ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                        ) : (
                            <Copy className="h-3.5 w-3.5" />
                        )}
                    </Button>
                )}
            </div>
        </div>
    );
}
