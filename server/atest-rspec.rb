# RSpec formatter for atest: appends each example's start and result to $ATEST_EVENTS as JSON lines, which
# `atest run` turns into the dashboard's progress file. Loaded through SPEC_OPTS, beside the usual formatter.
require "json"

class AtestFormatter
  RSpec::Core::Formatters.register self, :start, :example_started, :example_passed, :example_failed, :example_pending

  def initialize(_output)
    @f = File.open(ENV.fetch("ATEST_EVENTS"), "a")
    @f.sync = true
  end

  def start(n)
    emit(ev: "start", total: n.count)
  end

  def example_started(n)
    emit_case(n.example, "running")
  end

  def example_passed(n)
    emit_case(n.example, "passed")
  end

  def example_failed(n)
    e = n.example.execution_result.exception
    emit_case(n.example, "failed", e && "#{e.class}: #{e.message}"[0, 500])
  end

  def example_pending(n)
    emit_case(n.example, "skipped", n.example.execution_result.pending_message)
  end

  private

  def emit_case(ex, status, msg = nil)
    t = ex.execution_result.run_time
    emit(ev: "case", key: ex.id, id: ex.location, title: ex.full_description, status: status, msg: msg,
         ms: status == "running" || t.nil? ? nil : (t * 1000).round)
  end

  def emit(h)
    @f.flock(File::LOCK_EX)
    @f.write(JSON.generate(h) + "\n")
  ensure
    @f.flock(File::LOCK_UN)
  end
end
