package io.zooglass.testagent;

import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassHierarchyResolver;
import java.lang.classfile.ClassTransform;
import java.lang.classfile.CodeBuilder;
import java.lang.classfile.CodeElement;
import java.lang.classfile.CodeTransform;
import java.lang.classfile.MethodModel;
import java.lang.classfile.Opcode;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.nio.file.Files;
import java.nio.file.Path;
import static java.lang.constant.ConstantDescs.CD_void;

/** Pause only at the reviewed write entry and immediately after its real authority check. */
public final class InstrumentAuthority implements CodeTransform {
    private static final String NAME = "io/zooglass/runtime/PostgresAuthority";
    private static final ClassDesc GATE = ClassDesc.of("io.zooglass.testagent.WriterBarrier");
    private int sites;

    public static void main(String[] args) throws Exception {
        var api = ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(
                ClassHierarchyResolver.ofResourceParsing(InstrumentAuthority.class.getClassLoader())));
        var input = api.parse(Files.readAllBytes(Path.of(args[0])));
        if (!NAME.equals(input.thisClass().asInternalName())
                || input.methods().stream().filter(InstrumentAuthority::writeMethod).count() != 1) {
            throw new IllegalStateException("Expected the reviewed PostgresAuthority.write method");
        }
        var transform = new InstrumentAuthority();
        byte[] result = api.transformClass(input,
                ClassTransform.transformingMethodBodies(InstrumentAuthority::writeMethod, transform));
        if (transform.sites != 1) throw new IllegalStateException("Expected one write authority check");
        Files.write(Path.of(args[1]), result);
    }

    private static boolean writeMethod(MethodModel method) {
        return method.methodName().equalsString("write")
                && method.methodType().equalsString("(JJLjava/lang/String;)V");
    }
    @Override
    public void atStart(CodeBuilder code) {
        code.invokestatic(GATE, "writeBefore", MethodTypeDesc.of(CD_void));
    }
    @Override
    public void accept(CodeBuilder code, CodeElement element) {
        code.with(element);
        if (element instanceof InvokeInstruction invoke && invoke.opcode() == Opcode.INVOKEVIRTUAL
                && NAME.equals(invoke.owner().asInternalName()) && invoke.name().equalsString("require")
                && invoke.type().equalsString("(Ljava/lang/String;)L" + NAME + "$Row;")) {
            sites++;
            // Retain the checked row and every original operand on the stack unchanged.
            code.invokestatic(GATE, "writeLocked", MethodTypeDesc.of(CD_void));
        }
    }
}
