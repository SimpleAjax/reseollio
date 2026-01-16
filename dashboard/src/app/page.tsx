"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/status-badge";
import { StatsCard } from "@/components/stats-card";
import { JobDetailModal } from "@/components/job-detail-modal";
import { dummyJobs, dummyStats, type Job, type JobStatus } from "@/lib/dummy-data";
import {
  Search,
  RefreshCw,
  MoreVertical,
  RotateCcw,
  Trash2,
  Eye,
  TrendingUp,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Activity,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export default function DashboardPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTab, setSelectedTab] = useState<JobStatus | "ALL">("ALL");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const openJobDetail = (job: Job) => {
    setSelectedJob(job);
    setIsModalOpen(true);
  };

  const filteredJobs = dummyJobs.filter((job) => {
    const matchesSearch =
      job.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      job.id.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesTab = selectedTab === "ALL" || job.status === selectedTab;
    return matchesSearch && matchesTab;
  });

  const formatDuration = (ms?: number) => {
    if (!ms) return "-";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-secondary/20">
      {/* Header */}
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                <Activity className="h-6 w-6 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
                  Reseolio Dashboard
                </h1>
                <p className="text-sm text-muted-foreground">
                  Monitor and manage your background jobs
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="gap-2">
                <RefreshCw className="h-4 w-4" />
                Refresh
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-8 animate-in">
          <StatsCard
            title="Total Jobs"
            value={dummyStats.totalJobs.toLocaleString()}
            icon={Activity}
            description="All time"
          />
          <StatsCard
            title="Success Rate"
            value={`${dummyStats.successRate}%`}
            icon={TrendingUp}
            trend={{ value: 2.5, isPositive: true }}
          />
          <StatsCard
            title="Pending"
            value={dummyStats.pendingCount}
            icon={Clock}
            description="Waiting to execute"
          />
          <StatsCard
            title="Running"
            value={dummyStats.runningCount}
            icon={Activity}
            description="Currently executing"
          />
          <StatsCard
            title="Dead Jobs"
            value={dummyStats.deadCount}
            icon={XCircle}
            description="Needs attention"
          />
        </div>

        {/* Jobs Table  */}
        <div className="bg-card rounded-lg border shadow-sm animate-in">
          <div className="p-6 space-y-4">
            {/* Search and Filters */}
            <div className="flex items-center gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search jobs by name or ID..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            {/* Tabs */}
            <Tabs value={selectedTab} onValueChange={(v) => setSelectedTab(v as typeof selectedTab)}>
              <TabsList>
                <TabsTrigger value="ALL">
                  All <span className="ml-2 text-xs opacity-60">({dummyJobs.length})</span>
                </TabsTrigger>
                <TabsTrigger value="PENDING">
                  Pending <span className="ml-2 text-xs opacity-60">({dummyStats.pendingCount})</span>
                </TabsTrigger>
                <TabsTrigger value="RUNNING">
                  Running <span className="ml-2 text-xs opacity-60">({dummyStats.runningCount})</span>
                </TabsTrigger>
                <TabsTrigger value="SUCCESS">
                  Success <span className="ml-2 text-xs opacity-60">({dummyStats.successCount})</span>
                </TabsTrigger>
                <TabsTrigger value="FAILED">
                  Failed <span className="ml-2 text-xs opacity-60">({dummyStats.failedCount})</span>
                </TabsTrigger>
                <TabsTrigger value="DEAD">
                  Dead <span className="ml-2 text-xs opacity-60">({dummyStats.deadCount})</span>
                </TabsTrigger>
              </TabsList>

              <TabsContent value={selectedTab} className="mt-4">
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Status</TableHead>
                        <TableHead>Job Name</TableHead>
                        <TableHead>Job ID</TableHead>
                        <TableHead>Attempt</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead>Duration</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredJobs.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                            No jobs found matching your criteria
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredJobs.map((job) => (
                          <TableRow
                            key={job.id}
                            className="hover:bg-muted/50 transition-colors cursor-pointer"
                            onClick={() => openJobDetail(job)}
                          >
                            <TableCell>
                              <StatusBadge status={job.status} />
                            </TableCell>
                            <TableCell className="font-mono text-sm">
                              {job.name}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">
                              {job.id}
                            </TableCell>
                            <TableCell>
                              <span className="text-sm">
                                {job.attempt}/{job.maxAttempts}
                              </span>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground" suppressHydrationWarning>
                              {formatDistanceToNow(job.createdAt, { addSuffix: true })}
                            </TableCell>
                            <TableCell className="text-sm">
                              {formatDuration(job.duration)}
                            </TableCell>
                            <TableCell className="text-right">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 w-8 p-0"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <MoreVertical className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    className="gap-2"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openJobDetail(job);
                                    }}
                                  >
                                    <Eye className="h-4 w-4" />
                                    View Details
                                  </DropdownMenuItem>
                                  {(job.status === "FAILED" || job.status === "DEAD") && (
                                    <DropdownMenuItem className="gap-2">
                                      <RotateCcw className="h-4 w-4" />
                                      Retry Job
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuItem className="gap-2 text-destructive">
                                    <Trash2 className="h-4 w-4" />
                                    Delete Job
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </main>

      {/* Job Detail Modal */}
      <JobDetailModal
        job={selectedJob}
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
      />
    </div>
  );
}
