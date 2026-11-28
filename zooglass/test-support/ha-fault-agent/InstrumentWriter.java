package io.zooglass.testagent;

import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassHierarchyResolver;
import java.lang.classfile.ClassTransform;
import java.lang.classfile.CodeBuilder;
import java.lang.classfile.CodeElement;
import java.lang.classfile.CodeTransform;
import java.lang.classfile.Instruction;
import java.lang.classfile.MethodModel;
import java.lang.classfile.Opcode;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.nio.file.Files;
import java.nio.file.Path;

import static java.lang.constant.ConstantDescs.CD_void;

/** Preparation only. There are no configurable classes, locations or callbacks. */
public final class InstrumentWriter implements CodeTransform {
    private static final String WRITER_NAME = "io/zooglass/delivery/HaDelivery";
    private static final ClassDesc WRITER = ClassDesc.of("io.zooglass.delivery.HaDelivery");
    private static final ClassDesc SOCKET = ClassDesc.of("org.springframework.web.socket.WebSocketSession");
    private static final ClassDesc URI = ClassDesc.of("java.net.URI");
    private static final ClassDesc GATE = ClassDesc.of("io.zooglass.testagent.WriterBarrier");
    private Instruction previous;
    private int suppliers;
    private int sites;

    public static void main(String[] args) throws Exception {
        var api = ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(
                ClassHierarchyResolver.ofResourceParsing(InstrumentWriter.class.getClassLoader())));
        var input = api.parse(Files.readAllBytes(Path.of(args[0])));
        if (!WRITER_NAME.equals(input.thisClass().asInternalName())
                || input.methods().stream().filter(InstrumentWriter::writerMethod).count() != 1) {
            throw new IllegalStateException("Expected the reviewed HaDelivery.write()V method");
        }
        var transform = new InstrumentWriter();
        byte[] bytes = api.transformClass(input, ClassTransform.transformingMethodBodies(InstrumentWriter::writerMethod, transform));
        if (transform.suppliers != 1 || transform.sites != 1) {
            throw new IllegalStateException("Expected exactly one Pending.admit()/Supplier.get() handoff in write()");
        }
        Files.write(Path.of(args[1]), bytes);
    }

    private static boolean writerMethod(MethodModel method) {
        return method.methodName().equalsString("write") && method.methodType().equalsString("()V");
    }

    private static boolean call(Instruction instruction, Opcode opcode, String owner, String name, String descriptor) {
        return instruction instanceof InvokeInstruction invoke && invoke.opcode() == opcode
                && owner.equals(invoke.owner().asInternalName()) && invoke.name().equalsString(name)
                && invoke.type().equalsString(descriptor);
    }

    @Override
    public void accept(CodeBuilder code, CodeElement element) {
        if (element instanceof Instruction instruction) {
            if (call(instruction, Opcode.INVOKEINTERFACE, "java/util/function/Supplier", "get", "()Ljava/lang/Object;")) {
                suppliers++;
                if (call(previous, Opcode.INVOKEVIRTUAL, WRITER_NAME + "$Pending", "admit", "()Ljava/util/function/Supplier;")) {
                    sites++;
                    barrier(code, "before");
                    code.with(instruction);
                    barrier(code, "after");
                    previous = instruction;
                    return;
                }
            }
            previous = instruction;
        }
        code.with(element);
    }

    private static void barrier(CodeBuilder code, String stage) {
        // Leave the original operand (supplier or result) on the stack. The gate receives only
        // the socket URI, never the captured frame, credentials, owner or JDBC connection.
        code.aload(0).getfield(WRITER, "socket", SOCKET)
                .invokeinterface(SOCKET, "getUri", MethodTypeDesc.of(URI))
                .invokestatic(GATE, stage, MethodTypeDesc.of(CD_void, URI));
    }
}
